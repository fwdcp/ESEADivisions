var child_process = require('child_process');
var events = require('events');
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

var currentInfoUpdates = {};

express.get('/divisions/:id.json', function(req, res) {
    if (!req.params.id) {
        res.sendStatus(404);

        return;
    }

    if (!currentInfoUpdates[req.params.id]) {
        currentInfoUpdates[req.params.id] = new events.EventEmitter();

        var retrieve = child_process.fork('./load', ['--incremental', '--division', req.params.id]);

        retrieve.on('error', function(err) {
            currentInfoUpdates[req.params.id].emit('error');

            delete currentInfoUpdates[req.params.id];
        });

        retrieve.on('exit', function(code, signal) {
            if (code || signal) {
                currentInfoUpdates[req.params.id].emit('error');
            }
            else {
                currentInfoUpdates[req.params.id].emit('complete');
            }

            delete currentInfoUpdates[req.params.id];
        });
    }

    currentInfoUpdates[req.params.id].once('error', function() {
        res.sendStatus(500);
    });

    currentInfoUpdates[req.params.id].once('complete', function() {
        async.auto({
            teamSeasons: function(cb) {
                database.TeamSeason.find({event: req.params.id}, cb);
            },
            players: function(cb) {
                database.Player.find({'teams.event': req.params.id}, cb);
            }
        }, function(err, results) {
            if (err) {
                console.error(err);

                res.sendStatus(500);
            }
            else {
                var info = {
                    teams: underscore.map(results.teamSeasons, function(teamSeason) {
                        return underscore.omit(teamSeason.toObject(), 'raw', '__v', '_id');
                    }),
                    players: underscore.map(results.players, function(player) {
                        return underscore.omit(player.toObject(), 'raw', '__v', '_id');
                    })
                };

                res.json(info);
            }
        });
    });
});
