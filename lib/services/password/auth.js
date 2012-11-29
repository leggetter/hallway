var pm = require('profileManager');
var acl = require('acl');
var pwhash = require('password-hash');
var lutil = require('lutil');
var logger = require('logger').logger('password');

module.exports = {
  direct : function (app, req, res, cbAuthed) {
    var pass = req.param('password');
    var user = req.param('user');
    var account = req.param('account');

    if(!pass) return res.json(lutil.jsonErr("missing password"), 400);
    if(!user) return res.json(lutil.jsonErr("missing user"), 400);

    var hash = require('crypto').createHash('md5').update(user.toLowerCase()).digest('hex');
    var pid = hash+'-'+app.app+'@password';

    function auther() {
      var auth = {pid:pid};
      auth.user = user;
      auth.password = pwhash.generate(pass, {iterations:4242});
      if(req._authsome) auth.account = req._authsome.account; // allow optional existing account to be attached to
      return auth;
    }

    pm.authGet(pid, app.app, function(err, auth){
      if(err) logger.warn("error fetching ",pid,err);

      // also allowing here a mistaken registration w/ the same user and pass to just succeed like a normal login, be nice
      if(auth && pwhash.verify(pass, auth.password)) return cbAuthed(null, auth);

      // registration flow check
      if(req.path.indexOf("register") > 0)
      { // we must error out if the pid exists already in a registration flow
        if(auth) return res.json(lutil.jsonErr("user already exists"), 403);
        
        // new auth!
        auth = auther();
        auth.registered = Date.now();
        return cbAuthed(null, auth);
      }
      
      if(req.path.indexOf("set") > 0)
      {
        if(app.secret !== req.param('client_secret')) return  res.json(lutil.jsonErr("app not verified"), 401);
        
        // app-forced password set
        auth = auther();
        auth.set = Date.now();
        return cbAuthed(null, auth);        
      }

      res.json(lutil.jsonErr("login failed"), 401);
    });
  }
};

