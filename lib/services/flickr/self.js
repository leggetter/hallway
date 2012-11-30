var OAlib = require('oauth').OAuth;
var querystring = require('querystring');

exports.sync = function(pi, cb) {
  var oa = new OAlib(
    'http://www.flickr.com/services/oauth/request_token',
    'http://www.flickr.com/services/oauth/access_token',
    pi.auth.consumerKey,
    pi.auth.consumerSecret,
    '1.0',
    null,
    'HMAC-SHA1',
    null,
    {
      'Accept': '*/*',
      'Connection': 'close'
    }
   );
  // First, call check token to grab their ID
  var tokenUrl = 'http://api.flickr.com/services/rest/?' +
            'format=json&nojsoncallback=1&method=flickr.auth.oauth.checkToken';
  oa.getProtectedResource(tokenUrl, 'GET', pi.auth.token, pi.auth.tokenSecret,
    function (err, data, response) {
    if (err) return cb(err);
    try {
      data = JSON.parse(data);
    } catch(e) {
      return cb(e);
    }

    if (!(data && data.oauth && data.oauth.user && data.oauth.user.nsid)) {
      return cb('invalid checkToken resp from flickr:' + JSON.stringify(data));
    }

    // Then get all the user info about them
    var userUrl = 'http://api.flickr.com/services/rest/?' +
                  'format=json&nojsoncallback=1&method=flickr.people.getInfo' +
                  '&user_id=' + data.oauth.user.nsid;
    oa.getProtectedResource(userUrl, 'GET', pi.auth.token, pi.auth.tokenSecret,
      function (err, data, response) {
      if (err) return cb(err);

      try {
        data = JSON.parse(data);
      } catch(e) {
        return cb('invalid getInfo resp from flickr:' + JSON.stringify(data));
      }

      if (response.statusCode !== 200 ||
         !(data && data.person && data.person.id)) {
        return cb(response.statusCode + ': ' + JSON.stringify(data));
      }
      var me = data.person;
      pi.auth.pid = encodeURIComponent(me.id) + '@flickr';
      pi.auth.profile = me;

      data = {};
      data['profile:' + pi.auth.pid + '/self'] = [me];
      cb(null, {data: data, auth: pi.auth});
    });
  });
};
