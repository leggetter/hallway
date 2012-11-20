var async = require('async');
var request = require('request');

// I'm not in love w/ the experiment here to do two in one and how arg/type/
// types/etc is used, but it works for now

// XXX: This code sustains 20 concurrent requests (forEachLimit of 10 over 2
// types).

function FoF(type, arg, cb) {
  request.get({
    url: 'https://api.github.com/user/' + type,
    json: true,
    headers: arg.headers
  }, function (err, resp, users) {
    if (err || !users || !Array.isArray(users)) return cb(err);

    async.forEachLimit(users, 10, function (user, forEachUserCb) {
      request.get({
        url: 'https://api.github.com/users/' + user.login,
        json: true,
        headers: arg.headers
      }, function (err, resp, profile) {
        if (profile) arg.types[type].push(profile);

        forEachUserCb();
      });
    }, cb);
  });
}

exports.sync = function (processInfo, cb) {
  var arg = {
    types: {
      following: [],
      followers: []
    },
    headers: {
      Authorization: 'token ' + processInfo.auth.accessToken,
      Connection: 'keep-alive'
    }
  };

  async.forEach(Object.keys(arg.types),
    function (type, forEachCb) { FoF(type, arg, forEachCb); },
    function (err) {
    var data = {};

    data['user:' + processInfo.auth.pid + '/followers'] = arg.types.followers;
    data['user:' + processInfo.auth.pid + '/following'] = arg.types.following;

    cb(err, { data: data });
  });
};
