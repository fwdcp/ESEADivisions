require('v8-profiler');

var request = require('request');
var underscore = require('underscore');
var async = require('async');
var limiter = require('limiter');
var commander = require('commander');

var config = require('./config');
var database = require('./database');

var jar = request.jar();
jar.setCookie(request.cookie('viewed_welcome_page=1'), 'http://play.esea.net');

var ratelimiter = new limiter.RateLimiter(1, 'second');

commander
    .version('0.1.0')
    .option('--skip-division-teams', 'skip retrieving teams from divisions')
    .option('--skip-team-history', 'skip updating team history')
    .option('--skip-team-players', 'skip retrieving players from teams')
    .option('--skip-player-history', 'skip updating team history')
    .parse(process.argv);

async.auto({
    "esea": function(cb) {
        if (!commander.skipDivisionTeams) {
            ratelimiter.removeTokens(1, function() {
                request({
                    uri: 'http://play.esea.net/index.php',
                    qs: {
                        's': 'league',
                        'd': 'standings',
                        'format': 'json'
                    },
                    json: true,
                    jar: jar
                }, function(err, http, body) {
                    if (err || http.statusCode != 200) {
                        cb(err || http.statusCode);
                    }
                    else {
                        if (body.select_division_id) {
                            cb(null, body);
                        }
                        else {
                            cb(404);
                        }
                    }
                });
            });
        }
        else {
            cb();
        }
    },
    "divisions": ['esea', function(cb, results) {
        if (!commander.skipDivisionTeams) {
            cb(null, underscore.flatten(underscore.map(results.esea.select_division_id, function(season, seasonName) {
                return underscore.map(season, function(region, regionName) {
                    return underscore.map(region, function(divisionName, division) {
                        return division;
                    });
                });
            })));
        }
        else {
            cb();
        }
    }],
    "teams": ['divisions', function(cb, results) {
        if (!commander.skipDivisionTeams) {
            console.log('teams');
            console.time('teams');

            async.each(results.divisions, function(division, cb) {
                async.auto({
                    "esea": function(cb) {
                        ratelimiter.removeTokens(1, function() {
                            request({
                                uri: 'http://play.esea.net/index.php',
                                qs: {
                                    's': 'league',
                                    'd': 'standings',
                                    'division_id': division,
                                    'format': 'json'
                                },
                                json: true,
                                jar: jar
                            }, function(err, http, body) {
                                if (err || http.statusCode != 200) {
                                    cb(err || http.statusCode);
                                }
                                else {
                                    if (body.division && body.stem_tournaments) {
                                        cb(null, body);
                                    }
                                    else {
                                        cb(404);
                                    }
                                }
                            });
                        });
                    },
                    "division": ['esea', function(cb, results) {
                        cb(null, {
                            game: results.esea.division.game_id,
                            season: results.esea.division.season,
                            series: results.esea.division.stem_seriesid,
                            event: results.esea.division.stem_eventid,
                            division: results.esea.division.division_level,
                            region: results.esea.division.region_id
                        });
                    }],
                    "teams": ['esea', 'division', function(cb, results) {
                        async.each(results.esea.stem_tournaments, function(conference, cb) {
                            if (conference.type == 'regular season') {
                                var conferenceInfo = underscore.clone(results.division);
                                conferenceInfo.conference = conference.location;

                                async.each(conference.groups, function(group, cb) {
                                    var groupInfo = underscore.clone(conferenceInfo);
                                    groupInfo.group = group.name;

                                    async.each(group.active_teams, function(teamListing, cb) {
                                        var teamInfo = underscore.clone(groupInfo);
                                        teamInfo.team = teamListing.id;

                                        database.TeamSeason.findOne(teamInfo, function(err, teamSeason) {
                                            if (err) {
                                                cb(err);
                                            }
                                            else {
                                                if (!teamSeason) {
                                                    teamSeason = new database.TeamSeason(this);
                                                }

                                                teamSeason.name = teamListing.name;
                                                teamSeason.record.wins = teamListing.match_win;
                                                teamSeason.record.ties = teamListing.match_tie;
                                                teamSeason.record.losses = teamListing.match_loss;
                                                teamSeason.record.percentage = teamListing.match_win_pct;
                                                teamSeason.record.pointsFor = teamListing.point_win;
                                                teamSeason.record.pointsAgainst = teamListing.point_loss;

                                                teamSeason.raw.standings = teamListing;
                                                teamSeason.markModified('raw.standings');

                                                teamSeason.save(cb);
                                            }
                                        }.bind(teamInfo));
                                    }, cb);
                                }, cb);
                            }
                            else {
                                cb();
                            }
                        }, cb);
                    }]
                }, cb);
            }, function(err) {
                console.timeEnd('teams');

                cb(err);
            });
        }
        else {
            cb();
        }
    }],
    "teamHistory": ['teams', function(cb, results) {
        if (!commander.skipTeamHistory) {
            console.log('teamHistory');
            console.time('teamHistory');

            database.TeamSeason.find({'raw.history': {$exists: false}}, {'team': 1, 'series': 1, 'raw.history': 1}, function(err, teamSeasons) {
                if (err) {
                    cb(err);
                }
                else {
                    async.each(teamSeasons, function(teamSeason, cb) {
                        if (!teamSeason.raw.history) {
                            ratelimiter.removeTokens(1, function() {
                                request({
                                    uri: 'http://play.esea.net/teams/' + teamSeason.team,
                                    qs: {
                                        'tab': 'league',
                                        'period[type]': 'seasons',
                                        'period[season_start]': teamSeason.series,
                                        'format': 'json'
                                    },
                                    json: true,
                                    jar: jar
                                }, function(err, http, body) {
                                    if (err || http.statusCode != 200) {
                                        cb(err || http.statusCode);
                                    }
                                    else {
                                        teamSeason.raw.history = body;
                                        teamSeason.markModified('raw.history');

                                        if (teamSeason.raw.history.team_matches) {
                                            teamSeason.matches = underscore.map(teamSeason.raw.history.team_matches, function(match) {
                                                var matchInfo = {
                                                    id: match.id,
                                                    startTime: new Date(match.time_start * 1000),
                                                    endTime: new Date(match.time_end * 1000),
                                                    status: match.state,
                                                    outcomeType: match.outcome_type,
                                                    atFault: match.outcome_team_at_fault == teamSeason.team,
                                                    gamesPlayed: match.games,
                                                    map: match.games > 1 ? null : match.map_name,
                                                    result: match.result
                                                };

                                                if (match.entities[1].id == teamSeason.team) {
                                                    matchInfo.opposingTeam = match.entities[2].id;
                                                    matchInfo.gamesFor = match.team_1_games;
                                                    matchInfo.gamesAgainst = match.team_2_games;
                                                    matchInfo.pointsFor = match.team_1_points;
                                                    matchInfo.pointsAgainst = match.team_2_points;
                                                }
                                                else if (match.entities[2].id == teamSeason.team) {
                                                    matchInfo.opposingTeam = match.entities[1].id;
                                                    matchInfo.gamesFor = match.team_2_games;
                                                    matchInfo.gamesAgainst = match.team_1_games;
                                                    matchInfo.pointsFor = match.team_2_points;
                                                    matchInfo.pointsAgainst = match.team_1_points;
                                                }

                                                return matchInfo;
                                            });
                                        }
                                        else {
                                            teamSeason.matches = [];
                                        }

                                        teamSeason.save(cb);
                                    }
                                });
                            });
                        }
                        else {
                            cb();
                        }
                    }, function(err) {
                        console.timeEnd('teamHistory');

                        cb(err);
                    });
                }
            });
        }
        else {
            cb();
        }
    }],
    "players": ['teamHistory', function(cb, results) {
        if (!commander.skipTeamPlayers) {
            console.log('players');
            console.time('players');

            database.TeamSeason.find({'raw.history': {$exists: true}}, {'team': 1, 'raw.history.team_roster': 1}, function(err, teamSeasons) {
                if (err) {
                    cb(err);
                }
                else {
                    async.each(teamSeasons, function(teamSeason, cb) {
                        if (teamSeason.raw.history.team_roster) {
                            async.each(teamSeason.raw.history.team_roster, function(player, cb) {
                                database.Player.findOne({player: player.id}, {'player': 1, 'alias': 1}, function(err, playerDoc) {
                                    if (err) {
                                        cb(err);
                                    }
                                    else {
                                        if (!playerDoc) {
                                            playerDoc = new database.Player({
                                                player: this.id
                                            });

                                            playerDoc.alias = this.alias;

                                            playerDoc.save(cb);
                                        }
                                        else {
                                            cb();
                                        }
                                    }
                                }.bind(player));
                            }, cb);
                        }
                        else {
                            cb();
                        }
                    }, function(err) {
                        console.timeEnd('players');

                        cb(err);
                    });
                }
            });
        }
        else {
            cb();
        }
    }],
    "playerHistory": ['players', function(cb, results) {
        if (!commander.skipPlayerHistory) {
            console.log('playerHistory');
            console.time('playerHistory');

            database.Player.find({'raw.history': {$exists: false}}, {'player': 1, 'raw.history': 1}, function(err, players) {
                if (err) {
                    cb(err);
                }
                else {
                    async.each(players, function(player, cb) {
                        if (!player.raw.history) {
                            ratelimiter.removeTokens(1, function() {
                                request({
                                    uri: 'http://play.esea.net/users/' + player.player,
                                    qs: {
                                        'tab': 'history',
                                        'format': 'json'
                                    },
                                    json: true,
                                    jar: jar
                                }, function(err, http, body) {
                                    if (err || http.statusCode != 200) {
                                        cb(err || http.statusCode);
                                    }
                                    else {
                                        player.raw.history = body;
                                        player.markModified('raw.history');

                                        player.teams = underscore.map(player.raw.history.history_teams, function(teamSeason) {
                                            return {
                                                id: teamSeason.id,
                                                name: teamSeason.name,
                                                game: teamSeason.game_id,
                                                season: teamSeason.season,
                                                series: teamSeason.stem_seriesid,
                                                event: teamSeason.stem_eventid,
                                                division: teamSeason.division_level,
                                                matches: underscore.keys(teamSeason.matches)
                                            };
                                        });

                                        player.save(cb);
                                    }
                                });
                            });
                        }
                        else {
                            cb();
                        }
                    }, function(err) {
                        console.timeEnd('playerHistory');

                        cb(err);
                    });
                }
            });
        }
        else {
            cb();
        }
    }],
    "experienceRatings": ['playerHistory', 'teamHistory', function(cb, results) {
        console.log('experienceRatings');
        console.time('experienceRatings');

        database.TeamSeason.find({}, {'team': 1, 'game': 1, 'season': 1, 'series': 1, 'event': 1, 'division': 1, 'experienceRating': 1}, function(err, teamSeasons) {
            if (err) {
                cb(err);
            }
            else {
                async.each(teamSeasons, function(teamSeason, cb) {
                    async.auto({
                        'teamInfo': function(cb) {
                            cb(null, {
                                id: teamSeason.team,
                                game: teamSeason.game,
                                season: teamSeason.season,
                                series: teamSeason.series,
                                event: teamSeason.event,
                                division: teamSeason.division
                            });
                        },
                        'teamPlayers': ['teamInfo', function(cb) {
                            database.Player.find({
                                teams: {
                                    $elemMatch: results.teamInfo
                                }
                            }, cb);
                        }],
                        'weightedExperienceRating': ['teamInfo', 'teamPlayers', function(cb, results) {
                            cb(null, underscore.chain(results.teamPlayers).map(function(player) {
                                var season = underscore.findWhere(player.teams, results.teamInfo);

                                if (season && player.experienceRating[teamSeason.game]) {
                                    return season.matches.length * player.experienceRating[teamSeason.game];
                                }
                                else {
                                    return 0;
                                }
                            }).reduce(function(total, player) {
                                return total + player;
                            }).value());
                        }],
                        'matchesPlayed': ['teamPlayers', function(cb, results) {
                            cb(null, underscore.chain(results.teamPlayers).map(function(player) {
                                var season = underscore.findWhere(player.teams, results.teamInfo);

                                if (season) {
                                    return season.matches;
                                }
                                else {
                                    return [];
                                }
                            }).flatten().uniq().value().length);
                        }]
                    }, function(err, results) {
                        if (err) {
                            cb(err);
                        }
                        else {
                            if (results.matchesPlayed.length > 0) {
                                teamSeason.experienceRating = results.weightedExperienceRating / results.matchesPlayed;
                            }
                            else {
                                teamSeason.experienceRating = 0;
                            }

                            teamSeason.save(cb);
                        }
                    });
                }, function(err) {
                    console.timeEnd('experienceRatings');

                    cb(err);
                });
            }
        });
    }],
    "scheduleStrengths": ['teamMatches', 'experienceRating', function(cb, results) {
        console.log('scheduleStrengths');
        console.time('scheduleStrengths');

        database.TeamSeason.find({}, {'record': 1, 'matches': 1, 'scheduleStrength': 1}, function(err, teamSeasons) {
            if (err) {
                cb(err);
            }
            else {
                async.each(teamSeasons, function(teamSeason, cb) {
                    async.auto({
                        'regularSeasonMatches': function(cb) {
                            var played = teamSeason.record.wins + teamSeason.record.ties + teamSeason.record.losses;
                            var processed = 0;

                            cb(null, underscore.filter(teamSeason.matches, function(match) {
                                if (processed >= played) {
                                    cb(false);
                                }
                                else if (match.status == 'completed') {
                                    processed++;
                                    cb(true);
                                }
                                else {
                                    cb(false);
                                }
                            }));
                        },
                        'opposingTeamStrengths': ['regularSeasonMatches', function(cb, results) {
                            async.map(results.regularSeasonMatches, function(match) {
                                database.TeamSeason.findOne({season: teamSeason.season, team: match.opposingTeam}, {'record': 1, 'experienceRating': 1}, function(err, teamSeason) {
                                    if (err) {
                                        cb(err);
                                    }
                                    else {
                                        if (teamSeason) {
                                            cb(null, underscore.extend({
                                                wins: 0,
                                                ties: 0,
                                                losses: 0,
                                                pointsFor: 0,
                                                pointsAgainst: 0,
                                                experienceRating: 0
                                            }, teamSeason.record, {experienceRating: teamSeason.experienceRating}));
                                        }
                                        else {
                                            cb(null, {
                                                wins: 0,
                                                ties: 0,
                                                losses: 0,
                                                pointsFor: 0,
                                                pointsAgainst: 0,
                                                experienceRating: 0
                                            });
                                        }
                                    }
                                });
                            }, cb);
                        }]
                    }, function(err, results) {
                        if (err) {
                            cb(err);
                        }
                        else {
                            teamSeason.scheduleStrength = underscore.reduce(results.opposingTeamStrengths, function(memo, record) {
                                memo.wins += record.wins;
                                memo.ties += record.ties;
                                memo.losses += record.losses;
                                memo.pointsFor += record.pointsFor;
                                memo.pointsAgainst += record.pointsAgainst;
                                memo.experienceRating += record.experienceRating;

                                return memo;
                            }, {
                                wins: 0,
                                ties: 0,
                                losses: 0,
                                pointsFor: 0,
                                pointsAgainst: 0,
                                experienceRating: 0
                            });

                            teamSeason.save(cb);
                        }
                    });
                }, function(err) {
                    console.timeEnd('scheduleStrengths');

                    cb(err);
                });
            }
        });
    }]
});
