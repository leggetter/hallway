var url = require('url');
var request = require('request');

exports.proxy = function(auth, req, res) {
  var oauth = {
    consumer_key    : auth.consumerKey,
    consumer_secret : auth.consumerSecret,
    token           : auth.token,
    token_secret    : auth.tokenSecret
  };
  var uri = url.parse('http://api.flickr.com/services/rest');
  uri.query = req.query;
  // trying to mirror everything needed from orig req
  var arg = {method: req.method, oauth: oauth};
  arg.uri = url.format(uri);
  if(req.headers['content-type']) { // post or put only?
    req.headers = {'content-type': req.headers['content-type']};
    arg.body = req.body;
  }
  arg.json = true;
  request(arg).pipe(res);
};
