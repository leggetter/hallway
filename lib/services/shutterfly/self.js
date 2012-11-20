var request = require('request');

exports.sync = function(pi, cb) {
  request.get({uri:'https://api.klout.com/v2/user.oauth/'+pi.auth.user, headers:{authorization:'Bearer '+pi.auth.accessToken}, json:true}, function(err, resp, me){
    if(err) return cb(err);
    if(resp.statusCode != 200 || !me || !me.kloutId) return cb(resp.statusCode+': '+JSON.stringify(me))
    pi.auth.pid = me.kloutId+'@klout';
    pi.auth.profile = me;
    var data = {};
    data['profile:'+pi.auth.pid+'/self'] = [me];
    cb(null, {data:data, auth:pi.auth});
  });
}
