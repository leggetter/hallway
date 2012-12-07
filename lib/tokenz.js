var serializer = require('serializer'),
var logger = require('logger').logger('tokenz');
var lconfig = require('lconfig');

var SERIAL = serializer.createSecureSerializer(lconfig.authSecrets.crypt, lconfig.authSecret.sign);
var SERIALOLD = serializer.createSecureSerializer(lconfig.authSecrets.oldcrypt, lconfig.authSecret.oldsign);


function generateAccessToken(account, appID, template) {
  var out = template || {};
  // the equals is scary looking in a query arg value
  out.access_token = SERIAL.stringify([account, appID, +new Date()]).replace(/\=/g, '.');
  out.account = account;
  return out;
};

exports.parseAccessToken = function(atok) {
    var data = [];
    // above we escape equalzes, fix em up here
    atok = (atok && atok.replace(/\./g, '='));

    try {
      data = SERIAL.parse(atok);
    } catch(e) {
      try {
        data = SERIALOLD.parse(atok);
      } catch(e) {
        logger.error(e);
        throw new Error('Invalid OAuth access token.');
      }
      logger.warn("depreciated token",atok,data);
    }
    return {
      account: data[0],
      app: data[1],
      at: Date.parse(data[2])
    };
};

exports.login = function(req, res, next) {
  var atok;

  if(req.param('access_token')) {
    atok = req.param('access_token');
  } else if((req.headers.authorization || '').indexOf('Bearer ') === 0) {
    atok = req.headers.authorization.replace('Bearer', '').trim();
  } else {
    return next();
  }

  var token;
  try {
    token = exports.parseAccessToken(atok);
  } catch(e) {
    return res.json(lutil.jsonErr("Invalid OAuth access token."), 400);
  }

  // warn after 10 days
  var TOKEN_TTL = 10 * 24 * 60 * 60 * 1000;
  if (token.at + TOKEN_TTL < Date.now()) logger.warn('access token is old: %j', token);

  // for all api requests, they're legit now
  acl.getProfiles(token.account, function(err, profiles) {
    if (err || !profiles || profiles.length === 0) logger.warn('error getting profile',err,profiles);
    else {
      token.profiles = profiles;
      req._authsome = token;
    }
    next();
  });
};

exports.access_token = function(req, res, next) {
  var appID = req.body.client_id,
  var appSecret = req.body.client_secret,
  var redirect_uri = req.body.redirect_uri,
  var code = req.body.code;

  if (!(client_id && client_secret && code)) {
    return process.nextTick(function() {
      cb('invalid request client_id, client_secret, and code required');
    });
  }
  // verify that client id/secret pair are valid
  function callback(err, user) {
    logger.debug("returning ",err,user);
    if (err) logger.warn("oauth handshake failed",err);
    logger.anubis(null,{act:'auth', app:client_id, type:'auth', stage:'granted', user:user.id, error:err});
    cb(err, user);
  }
  logger.debug("LOOKUPGRANT "+client_id+":"+code);
  acl.getApp(client_id, function(err, app){
    if (err) return callback(err);
    if (!app) return callback(new Error('no such app'));
    if (app.secret !== client_secret) return callback(new Error('app secret mismatch'));
    acl.getGrant(code, function(err, grant){
      if (err) return callback(err);
      logger.debug(grant, typeof client_id);
      if (!grant || !grant.account) return callback(new Error('invalid grant'));
      if (grant.app !== client_id) return callback(new Error('app grant mismatch'));
      callback(undefined, {id:grant.account, pid:grant.pid});
    });
  });


      self.emit('lookup_grant', client_id, client_secret, code, function(err, user) {
        if(err) {
          res.writeHead(400);
          return res.end(err.message);
        }

        res.writeHead(200, {'Content-type': 'application/json'});

        user.req = req; // used to parse options!
        self.emit('create_access_token', user, client_id, function(template) {
          res.end(JSON.stringify(self.generateAccessToken(user.id, client_id, template)));
        });

        self.emit('remove_grant', user.id, client_id, code);
      });
    });
  });
};

var FirebaseTokenGenerator = require("./firebase-token-generator-node.js");
function createAccessToken(user, client_id, callback) {
  logger.debug("CREATING ACCESS TOKEN ",user,client_id);
  apiKeys.getKeys("firebase", client_id, function(keys){
    var template = {};
    // firebase token generation automation for apps
    if (keys) {
      logger.info("creating firebase token for",client_id,keys.appKey);
      var tokenGenerator = new FirebaseTokenGenerator(keys.appSecret);
      template.firebase = tokenGenerator.createToken({account: user.id});
    }
    if(!user.req || !user.pid || !user.req.param('profile')) return callback(template);

    // generating /profile result for this token request
    logger.debug("on-token profile generation", user.pid, user.req.param('profile'));
    acl.getProfiles(authsome.account, function(err, profiles) {
      profiles = profiles || {};
      var options = {};
      options.app = client_id;
      options.account = user.id;
      options.auth = lutil.isTrue(user.req.param('auth'));
      options.full = lutil.isTrue(user.req.param('full'));
      
      // only use the last pid if requested
      if (user.req.param('profile') == 'last') {
        var good = [];
        profiles.forEach(function(x){
          if(x.profile == user.pid) good.push(x);
        })
        profiles = good;
      }

      profileManager.genProfile(profiles, options, function(err, ret){
        template.profile = ret;
        callback(template);
      });
    });
  });
});

exports.appAccessToken = function(user_id, client_id, callback) {
  var self = this;
  self.emit('create_access_token', {id:user_id}, client_id, function(template) {
    callback(self.generateAccessToken(user_id, client_id, template));
  });
}

