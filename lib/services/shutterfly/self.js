var request = require('request');
var xml2js = require('xml2js');

exports.sync = function(pi, cb) {
  var url = 'https://ws.shutterfly.com/userid/'+pi.auth.user;  
  request.get({uri:url, headers:{authorization:'SFLY user-auth='+pi.auth.accessToken}, json:true}, function(err, resp, xml){
    if(err) return cb(err);
    if(resp.statusCode != 200) return cb("statusCode "+resp.statusCode+" "+xml);
    var parser = new xml2js.Parser();
    parser.parseString(xml, function(err, js){
      if(err) return cb(err);
      if(!js || !js.feed) return cb("invalid response: "+xml);
      
      pi.auth.pid = pi.auth.user+'@shutterfly';
      pi.auth.profile = js.feed;
      var data = {};
      data['user:'+pi.auth.pid+'/self'] = [js.feed];
      cb(null, {data:data, auth:pi.auth});
    });
  });
};
