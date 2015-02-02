var request = require('request');
var underscore = require('underscore');
var async = require('async');

var config = require('./config');
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
        "teams": ['esea', 'division', function(cb, results) {
            var teams = [];

            async.map(results.esea.stem_tournaments, function(conference, cb) {
                if (conference.type == 'regular season') {
                    var conferenceInfo = results.division;
                    conferenceInfo.conference = conference.location;

                    async.map(conference.groups, function(group, cb) {
                        var groupInfo = conferenceInfo;
                        groupInfo.group = group.name;

                        async.map(group.active_teams, [], function(teamsToUpdate, teamListing, cb) {
                            var teamInfo = groupInfo;
                            teamInfo.team = teamListing.id;

                            database.TeamSeason.findOne(teamInfo, function(err, teamSeason) {
                                if (err) {
                                    cb(err);
                                }

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

                                    teamsToUpdate.push(teamSeason);
                                }

                                cb(null, teamsToUpdate);
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
        }]
    }, function(err, results) {
        res.json(err || results);
    });
});
