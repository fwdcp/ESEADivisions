var request = require('request');
var underscore = require('underscore');
var async = require('async');

var config = require('./config');
var express = require('./express');

var jar = request.jar();
jar.setCookie(request.cookie('viewed_welcome_page=1'), 'http://play.esea.net');
