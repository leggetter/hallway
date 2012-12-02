var request = require('request');

exports.sync = function(pi, cb) {
  request.get({uri:'https://www.dwolla.com/oauth/rest/users/', qs:{oauth_token:pi.auth.accessToken}, json:true}, function(err, resp, me){
    if(err) return cb(err);
    if(resp.statusCode != 200 || !me || !me.Response || !me.Response.Id) return cb(resp.statusCode+': '+JSON.stringify(me))
    pi.auth.pid = me.Response.Id+'@dwolla';
    pi.auth.profile = me.Response;
    var data = {};
    data['account:'+pi.auth.pid+'/self'] = [me.Response];
    cb(null, {data:data, auth:pi.auth});
  });
}
