var request = require('request');

exports.sync = function(pi, cb) {
  var params = {'max-results':0, 'alt':'json'};
  request.get({uri:'https://picasaweb.google.com/data/feed/api/user/default', qs:params, headers:{authorization:'Bearer '+pi.auth.token.access_token, 'GData-Version': 2}, json:true}, function(err, resp, data){
    if(err) return cb(err);
    if(resp.statusCode != 200 || !data || !data.feed) return cb(resp.statusCode+': '+JSON.stringify(data));
    if(!data.feed.gphoto$user || !data.feed.gphoto$user.$t) return cb('missing id: '+JSON.stringify(data.feed));    
    pi.auth.pid = data.feed.gphoto$user.$t+'@picasa';
    pi.auth.profile = data.feed;
    var ret = {};
    ret['profile:'+pi.auth.pid+'/self'] = [data.feed];
    cb(null, {data:ret, auth:pi.auth});
  });
};
