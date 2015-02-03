var request = require('request');
var underscore = require('underscore');
var async = require('async');

var config = require('./config');
var database = require('./database');
var express = require('./express');

var jar = request.jar();
jar.setCookie(request.cookie('viewed_welcome_page=1'), 'http://play.esea.net');

express.get('/division/:id.json', function(req, res) {
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
                                        teamSeason = new database.TeamSeason(teamInfo);

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
                            });
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
                    async.map(teamSeason.raw.history.team_matches, function(match, cb) {
                        var matchInfo = {
                            id: match.id,
                            startTime: match.time_start,
                            endTime: match.time_end,
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
                                        player: player.id
                                    });

                                    playerDoc.save();
                                }

                                playerDoc.alias = player.alias;

                                playerDoc.save();

                                cb(null, playerDoc);
                            }
                        });
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
        "renderedTeams": ['division', 'teamMatches', 'players', function(cb, results) {
            database.TeamSeason.find({
                game: results.esea.division.game_id,
                season: results.esea.division.season,
                series: results.esea.division.stem_seriesid,
                event: results.esea.division.stem_eventid,
                division: results.esea.division.division_level,
                region: results.esea.division.region_id
            }, function(err, teamSeasons) {
                if (err) {
                    cb(err);
                }
                else {
                    async.map(teamSeasons, function(teamSeason, cb) {
                        var team;

                        async.auto({
                            'team': function(cb) {
                                team = teamSeason.toObject();

                                cb();
                            },
                            'scheduleStrength': ['team', function(cb) {
                                teamSeason.getScheduleStrength(function(err, scheduleStrength) {
                                    if (err) {
                                        cb(err);
                                    }
                                    else {
                                        team.scheduleStrength = scheduleStrength;

                                        cb();
                                    }
                                });
                            }],
                            'experienceRating': ['team', function(cb) {
                                teamSeason.getExperienceRating(function(err, experienceRating) {
                                    if (err) {
                                        cb(err);
                                    }
                                    else {
                                        team.experienceRating = experienceRating;

                                        cb();
                                    }
                                });
                            }]
                        }, function(err, results) {
                            cb(err, team);
                        });
                    }, cb);
                }
            });
        }]
    }, function(err, results) {
        res.json(err || results.renderedTeams);
    });
});
