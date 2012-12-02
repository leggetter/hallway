var url = require('url');
var request = require('request');

exports.proxy = function(auth, req, res)
{
  var uri = url.parse('https://picasaweb.google.com/data/feed/api/user'+req.url);
  uri.query = req.query;
  if(!uri.query.alt) uri.query.alt = 'json';
  // trying to mirror everything needed from orig req
  var arg = {method:req.method};
  arg.uri = url.format(uri);
  arg.headers = {};
  if(req.headers['content-type'])
  { // post or put only?
    arg.headers = {'content-type':req.headers['content-type']};
    arg.body = req.body;
  }
  arg.headers.authorization = 'Bearer '+auth.token.access_token;
  arg.headers['GData-Version'] = 2;
  arg.json = true;
  request(arg).pipe(res);
}