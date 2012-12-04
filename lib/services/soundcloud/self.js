var request = require('request');
var util = require('util');

exports.sync = function(pi, cb) {
  request.get({
    uri: 'https://api.soundcloud.com/me.json?oauth_token=' + pi.auth.accessToken,
    json: true
  }, function(err, resp, user) {
    if (err) {
      return cb(err);
    }

    if (resp.statusCode !== 200) {
      return cb(new Error("status code " + resp.statusCode + " " +
        util.inspect(user)));
    }

    if (!user) {
      return cb(new Error("missing response.user: " + util.inspect(user)));
    }

    var self = user;
    var auth = pi.auth;

    auth.profile = self; // map to shared profile
    auth.pid = self.id + '@soundcloud'; // profile id

    var base = 'profile:' + auth.pid + '/self';
    var data = {};

    data[base] = [self];

    cb(null, { auth: auth, data: data });
  });
};
