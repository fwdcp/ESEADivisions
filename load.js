var request = require('request');
var underscore = require('underscore');
var async = require('async');
var limiter = require('limiter');
var commander = require('commander');
var streamWorker = require('stream-worker');

var config = require('./config');
var database = require('./database');

var jar = request.jar();
jar.setCookie(request.cookie('viewed_welcome_page=1'), 'http://play.esea.net');

var ratelimiter = new limiter.RateLimiter(10, 'second');

commander
    .version('0.1.0')
    .option('--incremental', 'only retrieve records that may require an update')
    .option('--preload', 'only retrieve missing records')
    .option('--division [id]', 'retrieve records for a specific division', false)
    .option('--skip-division-teams', 'skip retrieving teams from divisions')
    .option('--skip-team-history', 'skip updating team history')
    .option('--skip-team-players', 'skip retrieving players from teams')
    .option('--skip-player-history', 'skip updating player history')
    .parse(process.argv);

var queryQueue = async.queue(function(query, cb) {
    query.exec(cb);
}, 10);

var saveQueue = async.queue(function(doc, cb) {
    doc.save(cb);
}, 10);

var incrementalTeams = [];
var incrementalPlayers = [];

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
            if (commander.division) {
                cb(null, [commander.division]);
            }
            else {
                cb(null, underscore.flatten(underscore.map(results.esea.select_division_id, function(season, seasonName) {
                    return underscore.map(season, function(region, regionName) {
                        return underscore.map(region, function(divisionName, division) {
                            return division;
                        });
                    });
                })));
            }
        }
        else {
            cb();
        }
    }],
    "teams": ['divisions', function(cb, results) {
        if (!commander.skipDivisionTeams) {
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

                                        queryQueue.push(database.TeamSeason.findOne(teamInfo), function(err, teamSeason) {
                                            if (err) {
                                                cb(err);
                                            }
                                            else {
                                                if (!teamSeason) {
                                                    teamSeason = new database.TeamSeason(teamInfo);
                                                }

                                                if (!underscore.isEqual(teamSeason.raw.standings, teamListing)) {
                                                    incrementalTeams.push(teamSeason.team);
                                                }

                                                teamSeason.raw.standings = teamListing;
                                                teamSeason.markModified('raw.standings');

                                                saveQueue.push(teamSeason, cb);
                                            }
                                        });
                                    }, cb);
                                }, cb);
                            }
                            else {
                                cb();
                            }
                        }, cb);
                    }]
                }, cb);
            }, cb);
        }
        else {
            cb();
        }
    }],
    "teamHistory": ['teams', function(cb, results) {
        if (!commander.skipTeamHistory) {
            var options = {};

            if (commander.preload) {
                options['raw.history'] = {$exists: false};
            }

            if (commander.division) {
                options['event'] = commander.division;
            }

            if (commander.incremental) {
                options['team'] = {$in: incrementalTeams};
            }

            streamWorker(database.TeamSeason.find(options, {'team': 1, 'series': 1, 'raw.history': 1}).stream(), 10, function(teamSeason, done) {
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

                                saveQueue.push(teamSeason, done);
                            }
                        });
                    });
                }
                else {
                    done();
                }
            }, cb);
        }
        else {
            cb();
        }
    }],
    "teamDetails": ['teams', 'teamHistory', function(cb, results) {
        var options = {};

        if (commander.division) {
            options['event'] = commander.division;
        }

        streamWorker(database.TeamSeason.find(options, {'raw.history': 1}).stream(), 10, function(teamSeason, done) {
            if (teamSeason.raw.standings) {
                teamSeason.name = teamSeason.raw.standings.name;
                teamSeason.record.wins = teamSeason.raw.standings.match_win;
                teamSeason.record.ties = teamSeason.raw.standings.match_tie;
                teamSeason.record.losses = teamSeason.raw.standings.match_loss;
                teamSeason.record.percentage = teamSeason.raw.standings.match_win_pct;
                teamSeason.record.pointsFor = teamSeason.raw.standings.point_win;
                teamSeason.record.pointsAgainst = teamSeason.raw.standings.point_loss;
            }

            if (teamSeason.raw.history) {
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
            }

            teamSeason.forfeits = underscore.reduce(teamSeason.matches, function(forfeits, match) {
                if (match.outcomeType == 'forfeit') {
                    if (match.atFault) {
                        forfeits.losses++;
                    }
                    else {
                        forfeits.wins++;
                    }
                }

                return forfeits;
            }, {
                wins: 0,
                losses: 0
            });

            saveQueue.push(teamSeason, done);
        }, cb);
    }],
    "players": ['teamHistory', function(cb, results) {
        if (!commander.skipTeamPlayers) {
            var options = {};

            if (commander.preload) {
                options['raw.history'] = {$exists: false};
            }

            if (commander.division) {
                options['event'] = commander.division;
            }

            streamWorker(database.TeamSeason.find(options, {'team': 1, 'raw.history.team_roster': 1}).stream(), 10, function(teamSeason, done) {
                if (teamSeason.raw.history.team_roster) {
                    async.each(teamSeason.raw.history.team_roster, function(playerInfo, cb) {
                        queryQueue.push(database.Player.findOne({player: playerInfo.id}, {'player': 1, 'alias': 1}), function(err, player) {
                            if (err) {
                                cb(err);
                            }
                            else {
                                if (!player) {
                                    player = new database.Player({
                                        player: playerInfo.id
                                    });

                                    incrementalPlayers.push(player.player);

                                    saveQueue.push(player, cb);
                                }
                                else {
                                    cb();
                                }
                            }
                        });
                    }, done);
                }
                else {
                    done();
                }
            }, cb);
        }
        else {
            cb();
        }
    }],
    "playerHistory": ['players', function(cb, results) {
        if (!commander.skipPlayerHistory) {
            var options = {};

            if (commander.preload) {
                options['raw.history'] = {$exists: false};
            }

            if (commander.division) {
                options['teams.event'] = commander.division;
            }

            if (commander.incremental) {
                options['team'] = {$in: incrementalPlayers};
            }

            streamWorker(database.Player.find(options, {'player': 1, 'raw.history': 1}).stream(), 10, function(player, done) {
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

                                saveQueue.push(player, done);
                            }
                        });
                    });
                }
                else {
                    done();
                }
            }, cb);
        }
        else {
            cb();
        }
    }],
    "playerDetails": ['players', 'playerHistory', function(cb, results) {
        var options = {};

        if (commander.division) {
            options['teams.event'] = commander.division;
        }

        streamWorker(database.Player.find(options, {'raw.history': 1}).stream(), 10, function(player, done) {
            if (player.raw.history) {
                if (player.raw.history.alias_history) {
                    player.alias = underscore.find(player.raw.history.alias_history, function(value) {
                        return underscore.isUndefined(value.last_used);
                    });
                }
                else {
                    player.alias = '';
                }

                if (player.raw.history.history_teams) {
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
                }
                else {
                    player.teams = [];
                }
            }

            saveQueue.push(player, done);
        }, cb);
    }],
    "experienceRatings": ['playerDetails', 'teamDetails', function(cb, results) {
        var options = {};

        if (commander.division) {
            options['teams.event'] = commander.division;
        }

        streamWorker(database.TeamSeason.find(options, {'team': 1, 'game': 1, 'season': 1, 'series': 1, 'event': 1, 'division': 1, 'experienceRating': 1}).stream(), 10, function(teamSeason, done) {
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
                'teamPlayers': ['teamInfo', function(cb, results) {
                    queryQueue.push(database.Player.find({teams: {$elemMatch: results.teamInfo}}), cb);
                }],
                'weightedExperienceRating': ['teamInfo', 'teamPlayers', function(cb, results) {
                    cb(null, underscore.chain(results.teamPlayers).map(function(player) {
                        var season = underscore.findWhere(player.teams, results.teamInfo);

                        if (season) {
                            return season.matches.length * player.getExperienceRating(teamSeason.game, teamSeason.season);
                        }
                        else {
                            return 0;
                        }
                    }).reduce(function(total, player) {
                        return total + player;
                    }, 0).value());
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
                    done(err);
                }
                else {
                    if (results.matchesPlayed > 0) {
                        teamSeason.experienceRating = results.weightedExperienceRating / results.matchesPlayed;
                    }
                    else {
                        teamSeason.experienceRating = 0;
                    }

                    saveQueue.push(teamSeason, done);
                }
            });
        }, cb);
    }],
    "scheduleStrengths": ['teamDetails', 'experienceRatings', function(cb, results) {
        var options = {};

        if (commander.division) {
            options['event'] = commander.division;
        }

        streamWorker(database.TeamSeason.find(options, {'season': 1, 'record': 1, 'matches': 1, 'scheduleStrength': 1}).stream(), 10, function(teamSeason, done) {
            async.auto({
                'regularSeasonMatches': function(cb) {
                    var played = teamSeason.record.wins + teamSeason.record.ties + teamSeason.record.losses;
                    var processed = 0;

                    cb(null, underscore.filter(teamSeason.matches, function(match) {
                        if (processed >= played) {
                            return false;
                        }
                        else if (match.status == 'completed') {
                            processed++;
                            return true;
                        }
                        else {
                            return false;
                        }
                    }));
                },
                'opposingTeamStrengths': ['regularSeasonMatches', function(cb, results) {
                    async.map(results.regularSeasonMatches, function(match, cb) {
                        queryQueue.push(database.TeamSeason.findOne({season: teamSeason.season, team: match.opposingTeam}, {'record': 1, 'experienceRating': 1}), function(err, teamSeason) {
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
                    done(err);
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

                    saveQueue.push(teamSeason, done);
                }
            });
        }, cb);
    }]
}, function(err, results) {
    if (err) {
        console.log(err);
        
        process.exit(1);
    }
    else {
        process.exit();
    }
});
