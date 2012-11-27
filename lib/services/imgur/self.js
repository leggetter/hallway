var OAlib = require('oauth').OAuth;

exports.sync = function(pi, cb) {
  var OA = new OAlib(null, null, pi.auth.consumerKey, pi.auth.consumerSecret, '1.0', null, 'HMAC-SHA1', null, {'Accept': '*/*', 'Connection': 'close'});
  var url = 'http://api.imgur.com/2/account.json';
  OA.get(url, pi.auth.token, pi.auth.tokenSecret, function(err, body){
    if(err) return cb(err);
    var js;
    try{ js = JSON.parse(body); }catch(E){ return cb(err); }
    if(!js || !js.account || !js.account.url) return cb("missing url");
    pi.auth.profile = js.account; // stash
    pi.auth.pid = js.account.url+'@imgur';
    var base = 'profile:'+pi.auth.pid+'/self';
    var data = {};
    data[base] = [js.account];
    cb(null, {auth:pi.auth, data:data});
  });
};
