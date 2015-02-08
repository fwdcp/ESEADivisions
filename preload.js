var request = require('request');
var underscore = require('underscore');
var async = require('async');
var limiter = require('limiter');

var config = require('./config');
var database = require('./database');

var jar = request.jar();
jar.setCookie(request.cookie('viewed_welcome_page=1'), 'http://play.esea.net');

var ratelimiter = new limiter.RateLimiter(1, 'second');

async.auto({
    "esea": function(cb) {
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
    },
    "divisions": ['esea', function(cb, results) {
        cb(null, underscore.flatten(underscore.map(results.esea.select_division_id, function(season, seasonName) {
            return underscore.map(season, function(region, regionName) {
                return underscore.map(region, function(divisionName, division) {
                    return division;
                });
            });
        })));
    }],
    "teams": ['divisions', function(cb, results) {
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

                                                teamSeason.save();
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

                                            teamSeason.save();

                                            cb();
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
    }],
    "teamHistory": ['teams', function(cb, results) {
        console.time('teamHistory');

        database.TeamSeason.find({}, 'team series', function(err, teamSeasons) {
            if (err) {
                cb(err);
            }
            else {
                async.each(teamSeasons, function(teamSeason, cb) {
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

                                teamSeason.save();

                                cb();
                            }
                        });
                    });
                }, function(err) {
                    console.timeEnd('teamHistory');

                    cb(err);
                });
            }
        });
    }],
    "matches": ['teamHistory', function(cb, results) {
        console.time('matches');

        database.TeamSeason.find({}, 'team raw.history', function(err, teamSeasons) {
            if (err) {
                cb(err);
            }
            else {
                async.each(teamSeasons, function(teamSeason, cb) {
                    if (teamSeason.raw.history.team_matches) {
                        teamSeason.matches = underscore.map(underscore.values(teamSeason.raw.history.team_matches), function(match) {
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

                    teamSeason.save();

                    cb();
                }, function(err) {
                    console.timeEnd('matches');

                    cb(err);
                });
            }
        });
    }],
    "players": ['teamHistory', function(cb, results) {
        console.time('players');

        database.TeamSeason.find({}, 'team raw.history', function(err, teamSeasons) {
            if (err) {
                cb(err);
            }
            else {
                async.each(teamSeasons, function(teamSeason, cb) {
                    if (teamSeason.raw.history.team_roster) {
                        async.each(teamSeason.raw.history.team_roster, function(player, cb) {
                            database.Player.findOne({player: player.id}, function(err, playerDoc) {
                                if (err) {
                                    cb(err);
                                }
                                else {
                                    if (!playerDoc) {
                                        playerDoc = new database.Player({
                                            player: this.id
                                        });

                                        playerDoc.save();
                                    }

                                    cb();
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
    }],
    "playerHistory": ['players', function(cb, results) {
        console.time('playerHistory');

        database.Player.find({}, 'player', function(err, players) {
            if (err) {
                cb(err);
            }
            else {
                async.each(players, function(player, cb) {
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

                                player.save();

                                cb();
                            }
                        });
                    });
                }, function(err) {
                    console.timeEnd('playerHistory');

                    cb(err);
                });
            }
        });
    }],
    "experienceRatings": ['playerHistory', 'matches', 'teamHistory', function(cb, results) {
        console.time('experienceRatings');

        database.TeamSeason.find({}, 'team game season series event division', function(err, teamSeasons) {
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

                            teamSeason.save();

                            cb();
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
        console.time('scheduleStrengths');

        database.TeamSeason.find({}, 'record matches', function(err, teamSeasons) {
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
                                database.TeamSeason.findOne({
                                    season: teamSeason.season,
                                    team: match.opposingTeam
                                }, 'record experienceRating', function(err, teamSeason) {
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

                            teamSeason.save();

                            cb();
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