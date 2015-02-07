var request = require('request');
var underscore = require('underscore');
var async = require('async');

var config = require('./config');
var database = require('./database');
var express = require('./express');

var jar = request.jar();
jar.setCookie(request.cookie('viewed_welcome_page=1'), 'http://play.esea.net');

express.get('/divisions/list.json', function(req, res) {
    async.auto({
        "esea": function(cb) {
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
        },
        "divisions": ['esea', function(cb, results) {
            cb(null, underscore.flatten(underscore.map(results.esea.select_division_id, function(season, seasonName) {
                return underscore.map(season, function(region, regionName) {
                    return underscore.map(region, function(divisionName, division) {
                        return {
                            id: division,
                            season: seasonName,
                            region: regionName,
                            division: divisionName
                        };
                    });
                });
            })));
        }]
    }, function(err, results) {
        res.json(err || results.divisions);
    });
});

express.get('/divisions/:id.json', function(req, res) {
    async.auto({
        "esea": function(cb) {
            request({
                uri: 'http://play.esea.net/index.php',
                qs: {
                    's': 'league',
                    'd': 'standings',
                    'division_id': req.params.id,
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
        "teamsToUpdate": ['esea', 'division', function(cb, results) {
            async.map(results.esea.stem_tournaments, function(conference, cb) {
                if (conference.type == 'regular season') {
                    var conferenceInfo = results.division;
                    conferenceInfo.conference = conference.location;

                    async.map(conference.groups, function(group, cb) {
                        var groupInfo = conferenceInfo;
                        groupInfo.group = group.name;

                        async.map(group.active_teams, function(teamListing, cb) {
                            var teamInfo = groupInfo;
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

                                    if (!underscore.isEqual(teamSeason.raw.standings, teamListing)) {
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

                                        cb(null, teamSeason);
                                    }
                                    else {
                                        cb();
                                    }
                                }
                            }.bind(underscore.clone(teamInfo)));
                        }, cb);
                    }, cb);
                }
                else {
                    cb(null, []);
                }
            }, function(err, results) {
                cb(err, underscore.compact(underscore.flatten(results)));
            });
        }],
        "teamsHistory": ['teamsToUpdate', function(cb, results) {
            async.map(results.teamsToUpdate, function(teamSeason, cb) {
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

                        cb(null, teamSeason);
                    }
                });
            }, cb);
        }],
        "teamMatches": ['teamsHistory', function(cb, results) {
            async.map(results.teamsHistory, function(teamSeason, cb) {
                if (teamSeason.raw.history.team_matches) {
                    async.map(underscore.values(teamSeason.raw.history.team_matches), function(match, cb) {
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

                        cb(null, matchInfo);
                    }, function(err, results) {
                        if (err) {
                            cb(err);
                        }
                        else {
                            teamSeason.matches = results;

                            teamSeason.save();

                            cb(null, teamSeason);
                        }
                    });
                }
                else {
                    teamSeason.matches = [];

                    teamSeason.save();

                    cb(null, teamSeason);
                }
            }, cb);
        }],
        "teamPlayers": ['teamsHistory', function(cb, results) {
            async.map(results.teamsHistory, function(teamSeason, cb) {
                if (teamSeason.raw.history.team_roster) {
                    async.map(teamSeason.raw.history.team_roster, function(player, cb) {
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

                                playerDoc.alias = this.alias;

                                playerDoc.save();

                                cb(null, playerDoc);
                            }
                        }.bind(player));
                    }, cb);
                }
                else {
                    cb(null, []);
                }
            }, function(err, results) {
                cb(err, underscore.compact(underscore.flatten(results)));
            });
        }],
        "players": ['teamPlayers', function(cb, results) {
            async.map(results.teamPlayers, function(player, cb) {
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

                        player.save();

                        async.map(player.raw.history.history_teams, function(teamSeason, cb) {
                            cb(null, {
                                id: teamSeason.id,
                                name: teamSeason.name,
                                game: teamSeason.game_id,
                                season: teamSeason.season,
                                series: teamSeason.stem_seriesid,
                                event: teamSeason.stem_eventid,
                                division: teamSeason.division_level,
                                matches: underscore.keys(teamSeason.matches)
                            });
                        }, function(err, results) {
                            if (err) {
                                cb(err);
                            }
                            else {
                                player.teams = results;

                                player.save();

                                cb(null, player);
                            }
                        });
                    }
                });
            }, cb);
        }],
        "teamsToRecalculate": ['players', 'teamsHistory', 'division', function(cb, results) {
            async.map(results.teamsHistory, function(teamSeason, cb) {
                var teams = underscore.pluck(teamSeason.matches, 'opposingTeam');

                teams.push(teamSeason.team);

                cb(null, teams);
            }, function(err, results) {
                if (err) {
                    cb(err);
                }
                else {
                    var teams = underscore.union(underscore.flatten(results));

                    async.map(teams, function(team, cb) {
                        var teamInfo = underscore.extend({}, results.division, {team: team});

                        database.TeamSeason.findOne(teamInfo, cb);
                    }, cb);
                }
            });
        }],
        "experienceRating": ['teamsToRecalculate', function(cb, results) {
            async.map(results.teamsToRecalculate, function(teamSeason, cb) {
                async.auto({
                    'teamPlayers': function(cb) {
                        database.Player.find({
                            teams: {
                                $elemMatch: {
                                    id: teamSeason.team,
                                    game: teamSeason.game,
                                    season: teamSeason.season,
                                    series: teamSeason.series,
                                    event: teamSeason.event,
                                    division: teamSeason.division
                                }
                            }
                        }, cb);
                    },
                    'weightedExperienceRating': ['teamPlayers', function(cb, results) {
                        async.map(results.teamPlayers, function(player, cb) {
                            var season = underscore.findWhere(player.teams, {
                                id: teamSeason.team,
                                game: teamSeason.game,
                                season: teamSeason.season,
                                series: teamSeason.series,
                                event: teamSeason.event,
                                division: teamSeason.division
                            });

                            if (season && player.experienceRating[teamSeason.game]) {
                                cb(null, season.matches.length * player.experienceRating[teamSeason.game]);
                            }
                            else {
                                cb(null, 0);
                            }
                        }, function(err, results) {
                            if (err) {
                                cb(err);
                            }
                            else {
                                async.reduce(results, 0, function(total, player, cb) {
                                    cb(null, total + player);
                                }, cb);
                            }
                        });
                    }],
                    'matchesPlayed': ['teamPlayers', function(cb, results) {
                        async.map(results.teamPlayers, function(player, cb) {
                            var season = underscore.findWhere(player.teams, {
                                id: teamSeason.team,
                                game: teamSeason.game,
                                season: teamSeason.season,
                                series: teamSeason.series,
                                event: teamSeason.event,
                                division: teamSeason.division
                            });

                            if (season) {
                                cb(null, season.matches);
                            }
                            else {
                                cb(null, []);
                            }
                        }, function(err, results) {
                            if (err) {
                                cb(err);
                            }
                            else {
                                cb(null, underscore.union(underscore.flatten(results)));
                            }
                        });
                    }]
                }, function(err, results) {
                    if (err) {
                        cb(err);
                    }
                    else {
                        if (results.matchesPlayed.length > 0) {
                            teamSeason.experienceRating = results.weightedExperienceRating / results.matchesPlayed.length;
                        }
                        else {
                            teamSeason.experienceRating = 0;
                        }

                        teamSeason.save();

                        cb(null, teamSeason);
                    }
                });
            }, cb);
        }],
        "scheduleStrength": ['experienceRating', function(cb, results) {
            async.map(results.experienceRating, function(teamSeason, cb) {
                async.auto({
                    'regularSeasonMatches': function(cb) {
                        var played = teamSeason.record.wins + teamSeason.record.ties + teamSeason.record.losses;
                        var processed = 0;

                        async.filterSeries(teamSeason.matches, function(match, cb) {
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
                        }, function(matches) {
                            cb(null, matches);
                        });
                    },
                    'opposingTeamStrengths': ['regularSeasonMatches', function(cb, results) {
                        async.map(results.regularSeasonMatches, function(match, cb) {
                            database.TeamSeason.findOne({
                                season: teamSeason.season,
                                team: match.opposingTeam
                            }, function(err, teamSeason) {
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

                        cb(null, teamSeason);
                    }
                });
            }, cb);
        }],
        "renderedTeams": ['division', 'scheduleStrength', function(cb, results) {
            database.TeamSeason.find(results.division, function(err, teamSeasons) {
                if (err) {
                    cb(err);
                }
                else {
                    async.map(teamSeasons, function(teamSeason, cb) {
                        cb(null, underscore.omit(teamSeason.toObject(), 'raw'));
                    }, cb);
                }
            });
        }]
    }, function(err, results) {
        res.json(err || results.renderedTeams);
    });
});
