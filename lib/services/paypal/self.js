var request = require('request');

exports.sync = function(pi, cb) {
  // TODO: Split this URL out into a base and endpoints if/when we add more
  request.get('https://identity.x.com/xidentity/resources/profile/me', {
    qs: {
      oauth_token: pi.auth.accessToken
    },
    json: true
  }, function(err, response, profile) {
    if (err) return cb(err);
    if (response.statusCode !== 200) {
      return cb(new Error('Response was not 200'));
    }

    var userId = profile && profile.identity && profile.identity.userId;
    if (!userId) return cb('No user ID found in profile');

    pi.auth.pid = userId + '@paypal';

    var base = 'profile:' + pi.auth.pid + '/self';
    pi.data = {};
    pi.data[base] = [profile];

    cb(null, pi);
  });
};
