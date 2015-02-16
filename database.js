var async = require('async');
var mongoose = require('mongoose');
var underscore = require('underscore');

var config = require('./config');

mongoose.connect(config.get('app:database'));

var playerSchema = new mongoose.Schema({
    player: Number,
    alias: String,
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

playerSchema.methods.getExperienceRating = function(game, season) {
    return underscore.reduce(this.teams, function(memo, team) {
        if (team.game == game && team.season <= season) {
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

            memo += multiplier * team.matches.length;
        }

        return memo;
    }, 0);
};

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

playerSchema.index({player: 1}, {unique: true});
playerSchema.index({'teams.id': 1, 'teams.name': 1, 'teams.game': 1, 'teams.season': 1, 'teams.series': 1, 'teams.event': 1, 'teams.division': 1});

var teamSeasonSchema = new mongoose.Schema({
    team: Number,
    name: String,
    game: Number,
    season: Number,
    series: Number,
    event: Number,
    region: Number,
    division: String,
    conference: String,
    group: String,
    record: {
        wins: Number,
        ties: Number,
        losses: Number,
        percentage: Number,
        pointsFor: Number,
        pointsAgainst: Number
    },
    forfeits: {
        wins: Number,
        losses: Number
    },
    experienceRating: Number,
    scheduleStrength: {
        wins: Number,
        ties: Number,
        losses: Number,
        percentage: Number,
        pointsFor: Number,
        pointsAgainst: Number,
        experienceRating: Number
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
        pointsAgainst: Number,
        result: String
    }],
    raw: {
        standings: Object,
        history: Object
    }
});

teamSeasonSchema.index({team: 1, game: 1, season: 1, series: 1, event: 1, region: 1, division: 1, conference: 1, group: 1}, {unique: true});

exports.mongoose = mongoose;
exports.Player = mongoose.model('Player', playerSchema);
exports.TeamSeason = mongoose.model('TeamSeason', teamSeasonSchema);
