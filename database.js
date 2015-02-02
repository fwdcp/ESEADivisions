var async = require('async');
var mongoose = require('mongoose');
var underscore = require('underscore');

var config = require('./config');

mongoose.connect(config.get('app:database'));

var playerSchema = new mongoose.Schema({
    player: Number,
    alias: String,
    url: String,
    teams: [{
        id: Number,
        name: String,
        game: Number,
        season: Number,
        series: Number,
        event: Number,
        division: String,
        matches: [Number]
    }],
    raw: {
        history: Object
    }
});

playerSchema.virtual('experienceRating').get(function() {
    return underscore.reduce(this.teams, function(memo, team) {
        var multiplier = 1;

        if (team.division == 'open') {
            multiplier = 1;
        }
        else if (team.division == 'intermediate') {
            multiplier = 2;
        }
        else if (team.division == 'main') {
            multiplier = 3;
        }
        else if (team.division == 'premier') {
            multiplier = 4;
        }
        else if (team.division == 'invite') {
            multiplier = 5;
        }

        if (!memo[team.game]) {
            memo[team.game] = 0;
        }

        memo[team.game] += multiplier * team.matches.length;

        return memo;
    }, {});
});

var teamSeasonSchema = new mongoose.Schema({
    team: Number,
    name: String,
    url: String,
    game: Number,
    season: Number,
    series: Number,
    division: String,
    conference: String,
    record: {
        wins: Number,
        ties: Number,
        losses: Number,
        percentage: Number,
        pointsFor: Number,
        pointsAgainst: Number
    },
    matches: [{
        id: Number,
        startTime: Date,
        endTime: Date,
        opposingTeam: Number,
        status: String,
        outcomeType: String,
        atFault: Boolean,
        gamesPlayed: Number,
        map: String,
        gamesFor: Number,
        gamesAgainst: Number,
        pointsFor: Number,
        pointsAgainst: Number
    }],
    raw: {
        standings: Object,
        history: Object
    }
});

teamSeasonSchema.methods.getScheduleStrength = function(cb) {
    async.auto({
        'regularSeasonMatches': function(cb) {
            var played = this.record.wins + this.record.ties + this.record.losses;
            var processed = 0;

            async.filterSeries(this.matches, function(match, cb) {
                if (processed >= played) {
                    cb(false);
                }

                if (match.status == 'completed') {
                    processed++;
                    cb(true);
                }

                else {
                    cb(false);
                }
            }, function(matches) {
                cb(null, matches);
            });
        }.bind(this),
        'opposingTeamStrengths': ['regularSeasonMatches', function(cb, results) {
            var season = this.season;

            async.map(results.regularSeasonMatches, function(match, cb) {
                mongoose.model('TeamSeason').findOne({
                    season: season,
                    team: match.opposingTeam
                }, function(err, teamSeason) {
                    if (err) {
                        cb(err);
                    }
                    else {
                        cb(null, teamSeason.record);
                    }
                });
            }, cb);
        }.bind(this)],
        'scheduleStrength': ['opposingTeamStrengths', function(cb, results) {
            async.reduce(results.opposingTeamStrengths, {
                wins: 0,
                ties: 0,
                losses: 0,
                pointsFor: 0,
                pointsAgainst: 0
            }, function(memo, record, cb) {
                memo.wins += record.wins;
                memo.ties += record.ties;
                memo.losses += record.losses;
                memo.pointsFor += record.pointsFor;
                memo.pointsAgainst += record.pointsAgainst;

                cb(null, memo);
            }, cb);
        }]
    }, function(err, results) {
        cb(err, results.scheduleStrength);
    });
};

teamSeasonSchema.methods.getExperienceRating = function(cb) {
    async.auto({
        'teamPlayers': function(cb) {
            mongoose.model('Player').find({
                teams: {
                    $elemMatch: {
                        id: this.team,
                        game: this.game,
                        season: this.season,
                        series: this.series,
                        division: this.division
                    }
                }
            }, cb);
        }.bind(this),
        'weightedExperienceRating': ['teamPlayers', function(cb, results) {
            var team = this;

            async.map(results.teamPlayers, function(player, cb) {
                var season = underscore.findWhere(player.teams, {
                    id: team.team,
                    game: team.game,
                    season: team.season,
                    series: team.series,
                    division: team.division
                });

                if (season) {
                    cb(null, season.matches.length * player.experienceRating);
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
        }.bind(this)],
        'playedGames': ['teamPlayers', function(cb, results) {
            var team = this;

            async.map(results.teamPlayers, function(player, cb) {
                var season = underscore.findWhere(player.teams, {
                    id: team.team,
                    game: team.game,
                    season: team.season,
                    series: team.series,
                    division: team.division
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
                    cb(null, underscore.partial(underscore.union, results));
                }
            });
        }.bind(this)]
    }, function(err, results) {
        if (err) {
            cb(err);
        }
        else {
            if (results.playedGames.length > 0) {
                cb(null, results.weightedExperienceRating / results.playedGames.length);
            }
            else {
                cb(null, 0);
            }
        }
    });
};

exports.mongoose = mongoose;
exports.Player = mongoose.model('Player', playerSchema);
exports.TeamSeason = mongoose.model('TeamSeason', teamSeasonSchema);
