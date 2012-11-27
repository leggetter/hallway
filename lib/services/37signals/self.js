var request = require('request');

exports.sync = function(pi, cb) {
  request.get('https://launchpad.37signals.com/authorization.json', { headers:{'Authorization': 'bearer '+pi.auth.token.access_token}, json: true }, function(err, response, profile) {
    if (err) return cb(err);
    if (response.statusCode !== 200) return cb(new Error('Response was '+response.statusCode));
    if (!profile || !profile.identity || !profile.identity.id) return cb('No user ID found in profile');

    pi.auth.pid = profile.identity.id + '@37signals';

    var base = 'authorization:' + pi.auth.pid + '/self';
    pi.data = {};
    pi.data[base] = [profile];

    cb(null, pi);
  });
};
