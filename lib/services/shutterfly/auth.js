var crypto = require('crypto');

module.exports = {
  handler : function (callback, apiKeys, done, req, res) {
    var request = require('request');
    var qs = require('url').parse(req.url, true).query;
    
    // second phase, post-user-authorization
    if(qs && qs.oflyUserAuthToken)
    {
      return done(null, {accessToken:qs.oflyUserAuthToken, clientID:apiKeys.appKey, clientSecret:apiKeys.appSecret, user:qs.oflyUserid});
    }

    // first phase, initiate user authorization
    var path = '/oflyuser/createToken.sfly?oflyCallbackUrl='+callback+'&oflyAppId='+apiKeys.appKey+'&oflyHashMeth=SHA1&oflyTimestamp='+new Date().toISOString();
    var sig = crypto.createHash("sha1").update(apiKeys.appSecret+path).digest('hex');
    path += '&oflyApiSig='+sig;
    res.redirect('http://www.shutterfly.com'+path);
  }
}
