var mongoose = require('mongoose');

var config = require('./config');

mongoose.connect(config.get('app:database'));

var teamSeasonSchema = new mongoose.Schema({
    season: Number,
    series: Number,
    record: {
        wins: Number,
        ties: Number,
        losses: Number,
        percentage: Number,
        roundsFor: Number,
        roundsAgainst: Number
    },
    players: [],
    raw: {
        division: Object,
        history: Object
    }
});

var teamSchema = new mongoose.Schema({
    team: Number,
    name: String,
    url: String,
    seasons: [teamSeasonSchema]
});

exports.mongoose = mongoose;
exports.Team = mongoose.model('Team', teamSchema);
