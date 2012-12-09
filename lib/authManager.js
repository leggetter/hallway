/*
* Copyright (C) 2012 Singly, Inc. All Rights Reserved.
*
* Redistribution and use in source and binary forms, with or without
* modification, are permitted provided that the following conditions are met:
*    * Redistributions of source code must retain the above copyright
*      notice, this list of conditions and the following disclaimer.
*    * Redistributions in binary form must reproduce the above copyright
*      notice, this list of conditions and the following disclaimer in the
*      documentation and/or other materials provided with the distribution.
*    * Neither the name of the Locker Project nor the
*      names of its contributors may be used to endorse or promote products
*      derived from this software without specific prior written permission.
*
* THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
* ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
* WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
* DISCLAIMED. IN NO EVENT SHALL THE LOCKER PROJECT BE LIABLE FOR ANY
* DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
* (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
* LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
* ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
* (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
* SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

var path = require('path');
var fs = require('fs');
var querystring = require('querystring');
var request = require('request');
var async = require('async');
var sanitizer = require('sanitizer');
var urllib = require('url');
var util = require('util');
var lutil = require('lutil');
var ijod = require('ijod');
var push = require('push');
var pipeline = require('pipeline');
var lconfig = require('lconfig');
var logger = require('logger').logger("authManager");
var taskman = require('taskman');
var acl = require('acl');
var profileManager = require('profileManager');
var instruments = require("instruments");
var tokenz = require('tokenz');
var apiKeys = require('apiKeys');
var crypto = require('crypto');
var host = lconfig.externalBase + '/';

// wrapper to watch auth errors
function authfail(req, service, res, E, app, callback) {
  instruments.increment("auth.error."+service).send();
  logger.warn('auth fail',service,E);
  logger.anubis(null, {
    act     : 'auth',
    app     : app,
    type    : 'autherror',
    service : service,
    error   : E
  });
  // if there is a callback, then don't touch the res object (used in forEach
  // for batch calls)
  if (typeof callback === 'function') return callback(E);

  // respond directly if applied request
  if (res.applied_flag) return res.json(lutil.jsonErr(E), 500);
  // no choice but to barf to user if no callback!
  if (!req.cookies || !req.cookies.callback) return res.send(E, 500);
  var url = req.cookies.callback && urllib.parse(req.cookies.callback,true);
  if (!url || !url.query || !url.query.redirect_uri) return res.send(E, 500);
  var redirect_uri = url.query.redirect_uri;
  // hash, ?, or & to append?
  redirect_uri += (url.query.response_type === 'token') ? '#' : ((redirect_uri.indexOf('?') > 0) ? '&' : '?');
  redirect_uri += 'error='+encodeURIComponent(util.inspect(E));
  logger.warn('redirecting back to',redirect_uri);
  res.redirect(redirect_uri);
}

// and get the auth url for it to return
function startServiceAuth(service, appID, req, res) {
  logger.debug('starting service auth for '+service,appID);
  logger.anubis(req, {
    act     : 'auth',
    app     : appID,
    type    : 'auth',
    service : service,
    stage   : 'start'
  });
  var authModule;
  // local services, load up directly
  if (fs.existsSync(path.join(__dirname, 'services', service))) {
    try {
      authModule = require(path.join('services', service, 'auth.js'));
    } catch (E) {
      logger.warn("can't load auth.js for "+service,E);
      return authfail(req, service, res, "Service init failed: "+sanitizer.escape(service), appID);
    }
  }else{
    // if the target service is also an app, let's see if they support APIaaS
    acl.getApp(service, function(err, app){
      if (err || !app || !app.notes.apiauth) {
        return authfail(req, service, res, "Unknown service: "+sanitizer.escape(service), appID);
      }
      var url = urllib.parse(app.notes.apiauth, true);
      delete url.search;
      url.query.callback = lconfig.externalBase + '/auth/' + service + '/auth/' + appID;
      logger.debug('app2app auth redirect '+urllib.format(url));
      return res.redirect(urllib.format(url));
    });
    return; // def don't continue below, that's for built-ins only
  }

  // oauth2 types redirect
  if (authModule.authUrl) {
	logger.debug('starting oauth2');
    return apiKeys.getKeys(service, appID, function(keys) {
      if (!keys) {
        return authfail(req, service, res, 'missing required oauth2 api keys', appID);
      }
      // some are strict and have to fallback to cookie based
      var suffix = (authModule.strict) ? '' : '/'+appID;
      var url;
      if (typeof authModule.authUrl === 'function') {
        url = urllib.parse(authModule.authUrl(req), true);
      } else {
        url = urllib.parse(authModule.authUrl, true);
      }

      delete url.search; // totally lame that this supercedes url.query!
      if (req.query.hasOwnProperty('scope')) url.query.scope = req.query.scope;
      url.query.client_id = keys.appKey;
      url.query.redirect_uri = lconfig.externalBase + '/auth/' + service + '/auth'+suffix;
      logger.debug('redirecting to '+urllib.format(url));
      return res.redirect(urllib.format(url));
    });
  }
  logger.debug('auth falling past oauth2');
  // everything else is pass-through (custom, oauth1, etc)
  exports.authIsAuth(service, appID, req, res);
}

function finishOAuth2(code, redirect, authModule, theseKeys, callback) {
  // oauth2 callbacks from here on out
  var method = authModule.handler.oauth2;
  var postData = {
    client_id: theseKeys.appKey,
    client_secret: theseKeys.appSecret,
    redirect_uri: redirect,
    grant_type: authModule.grantType,
    code: code
  };
  if(authModule.type) {
    delete postData.grant_type;
    postData.type = authModule.type;
  }
  var req = {
    method: method,
    url: authModule.endPoint
  };
  if (method === 'POST') {
    req.body = querystring.stringify(postData);
    req.headers = {'Content-Type' : 'application/x-www-form-urlencoded'};
  } else if (method === 'BASIC'){
    req.headers = {'Authorization': "Basic " + new Buffer(postData.client_id+':'+postData.client_secret).toString("base64") };
    delete postData.client_id;
    delete postData.client_secret;
    req.body = querystring.stringify(postData);
    req.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    req.method='POST'; // dunno why, but this is required here!
  } else {
    req.url += '/access_token?' + querystring.stringify(postData);
  }
  logger.debug("oauth2 finish requesting",req);
  request(req, function (err, resp, body) {
    try {
      body = JSON.parse(body);
    } catch(err) {
      body = querystring.parse(body);
    }
    var auth = {
      accessToken: body.access_token, // legacy that there's two different patterns here
      token: body,
      clientID: theseKeys.appKey,
      clientSecret: theseKeys.appSecret
    };
    if (typeof authModule.authComplete !== 'function') return callback(undefined, auth);
    return authModule.authComplete(auth, callback);
  });
}

// handle actual auth api requests or callbacks, much conflation to keep /auth/foo/auth consistent everywhere!
exports.authIsAuth = function(service, appID, req, res) {
  logger.verbose('processing auth for '+service,appID);
  logger.anubis(req,{act:'auth', app:appID, type:'auth', service:service, stage:'auth'});

  var authModule;
  // local services, load up directly
  if (fs.existsSync(path.join(__dirname, 'services', service))) {
    try {
      authModule = require(path.join('services', service, 'auth.js'));
    } catch (E) {
      logger.warn("can't load auth.js for "+service,E);
      return authfail(req, service, res, "Service init failed: "+sanitizer.escape(service), appID);
    }
  }else{
    // APIaaS callback
    if (req.query.error) return authfail(req, service, res, "Error returned from app-service: "+sanitizer.escape(req.query.error), appID);
    acl.getApp(service, function(err, app){
      if (err || !app) return authfail(req, service, res, "Unknown service: "+sanitizer.escape(service), appID);
      // for now, temporary validation scheme, DO NOT USE, is replayable
      var match = crypto.createHash('md5').update(app.secret+req.query.account).digest('hex');
      if (match !== req.query.validation || !app.notes.apiauth) return authfail(req, service, res, "Service validation failed for "+sanitizer.escape(service), appID);
      acl.isAppAccount(service, req.query.account, function(valid){
        if (!valid) return authfail(req, service, res, "Invalid account returned: "+sanitizer.escape(req.query.account), appID);
        // valid auth happened from app-service permissioning appID to access req.query.account!
        // hackney, create auth object like a normal service and self synclet and apiauth flag
        delete req.query.secret;
        var auth = {
          applied: Date.now(),
          pid: req.query.account + '@' + service,
          profile:req.query,
          apiauth:app.notes.apiauth
        };
        finishAuth(req, res, service, auth, appID);
      });
    });
    return; // def don't continue below, that's for built-ins only
  }

  // some custom code gets run for non-oauth2 options here, wear a tryondom
  if (typeof authModule.direct === 'function') {
    try {
      // internally can respond to req too and never call back
      return acl.getApp(appID, function(err, app){
        if (err || !app) return authfail(req, service, res, "Unknown app: ", appID);
        authModule.direct(app, req, res, function(err, auth){
          if (err) return authfail(req, service, res, err, appID);
          if (!auth) return logger.warn("direct auth failed",service,appID);
          res.self_flag = true;
          res.applied_flag = true;
          finishAuth(req, res, service, auth, appID); // based on our flags, won't run self and will return directly!
        });
      });
    } catch (err) {
      return authfail(req, service, res, err, appID);
    }
  }

  var suffix = (authModule.strict) ? '' : '/'+appID; // some are strict and have to fallback to cookie based
  var redirectURI = lconfig.externalBase + '/auth/' + service + '/auth'+suffix;

  // now keys are required, this also validates appID
  apiKeys.getKeys(service, appID, function(keys){
    if (!keys) return authfail(req, service, res, 'missing required api keys', appID);

    if (typeof authModule.handler === 'function') {
      try {
        return authModule.handler(redirectURI, keys, function (err, auth) {
          if (err) return authfail(req, service, res, err, appID);
          finishAuth(req, res, service, auth, appID);
        }, req, res);
      } catch (E) {
        logger.error(E);
        return authfail(req, service, res, E, appID);
      }
    }

    var code = req.param('code');
    if (!code || !authModule.handler.oauth2) return authfail(req, service, res, 'missing auth code '+req.param('error')+' '+(req.param('error_description')||''), appID);
    finishOAuth2(code, redirectURI, authModule, keys, function (err, auth) {
      if (err) return authfail(req, service, res, err, appID);
      finishAuth(req, res, service, auth, appID);
    });

  });
};

// if there's an incoming account, make sure it exists first
function accountCheck(auth, cbDone)
{
  if(!auth.account) return cbDone();
  acl.getProfiles(auth.account, function(err, profiles){
    if(err) return cbDone(err);
    if(!profiles || profiles.length == 0) return cbDone("account id doesn't exist: "+auth.account);
    cbDone();
  });
}

// handler for app applied auth directly
exports.authApply = function(service, req, res) {
  var appID = req.query.client_id;
  acl.getApp(appID, function(err, app){
    if (err) return res.json(lutil.jsonErr(err), 500);
    if (!app) return res.json(lutil.jsonErr('no such app'), 404);
    if (app.secret !== req.query.client_secret) return res.json(lutil.jsonErr('validation failed'), 401);
    if (!app.apikeys || !app.apikeys[service]) return res.json(lutil.jsonErr('missing production service keys'), 404);
    var auth = insertAuth(app, service, req.query);
    res.applied_flag = true; // signals to respond directly w/ all results
    accountCheck(auth, function(err){
      if(err) return res.json(lutil.jsonErr(err), 500);
      finishAuth(req, res, service, auth, appID);
    });
  });
};

// format:
// {
//   "id": "<your-apps-userid1>",
//   "facebook": {
//     "token": "<user1-facebook-token>"
//   },
//   "twitter": {
//     "token": "<user1-twitter-token>",
//     "token_secret": "<user1-twitter-token-secret>",
//   }
// }
exports.batchApplyAuth = function(req, res, appID, appSecret, accounts, callback) {
  acl.getApp(appID, function(err, app) {
    if (err) return callback(err);
    if (!app) return callback(new Error('no such app'));
    if (app.secret !== appSecret) return callback(new Error('validation failed'));
    if (!app.apikeys) return callback(new Error('missing production keys'));

    var singlyAccounts = {};
    for (var i in accounts) {
      var account = accounts[i];
      if (!account) {
        return callback(new Error('object at index ' + i + ' is invalid:' +
            account));
      }
      if (!account.hasOwnProperty('id') || (!account.id && account.id !== 0)) {
        return callback(new Error('object at index ' + i + ' has and invalid' +
            ' id:' + account.id));
      }
    }

    // loop through all the accounts passed in
    async.forEachLimit(accounts, 5, function(account, cbAccount) {
      // accounts are identified by an "id" value that comes from the app
      // we use this as the key for the singly object for easy looping and
      // lookup on their end when passed back
      var id = account.id;
      delete account.id;
      var services = Object.keys(account);
      var thisAccount = {};
      // loop through all the services for this account
      async.forEachSeries(services, function(service, cbService) {
        if (!app.apikeys[service]) {
          thisAccount[service] = {
            error : new Error('missing production service keys')
          };
          return process.nextTick(cbService);
        }
        var auth = insertAuth(app, service, account[service]);
        if (thisAccount.sid) auth.account = thisAccount.sid;
        res.applied_flag = true; // signals to respond directly w/ all results
        res.batch = true;
        finishAuth(req, res, service, auth, appID, function(err, newAccount) {
          if (err) {
            if (!thisAccount.error) thisAccount.error = {};
            thisAccount.error[service] = err.toString();
            return cbService();
          }
          thisAccount.sid = newAccount.account;
          thisAccount.access_token = newAccount.access_token;
          cbService();
        });
      }, function() {
        singlyAccounts[id] = thisAccount;
        process.nextTick(cbAccount);
      });
    }, function() {
      callback(null, singlyAccounts);
    });
  });
};

function insertAuth(app, service, query) {
  var keys = app.apikeys[service];
  var auth = {
    applied: Date.now(),
    clientID: keys.appKey,
    clientSecret: keys.appSecret
  };
  // there's different formats between oauth1 and 2 meh :/
  if (query.token_secret) {
    // oauth1 services expect these names instead
    auth.consumerKey = keys.appKey;
    auth.consumerSecret = keys.appSecret;
    // these two are oddballs in how they did their oauth1 token storage
    if (service === 'tumblr' || service === 'twitter') {
      auth.token = {
        oauth_token: query.token,
        oauth_token_secret: query.token_secret
      };
    } else {
      auth.token = query.token;
      auth.tokenSecret = query.token_secret;
    }
  } else {
    auth.token = query; // stash all variables in case there were per-service ones as allowed in oauth2
    auth.token.access_token = query.token; // properly named
    // also needs to be refactored someday, lame difference
    if (service === 'facebook' ||
       service === 'foursquare' ||
       service === 'github') {
      auth.accessToken = query.token;
    }
  }
  if (query.scope) auth.scope = query.scope;
  if (query.account) auth.account = query.account;
  return auth;
}

// save out auth and kick-start synclets, plus respond
function finishAuth(req, res, service, auth, appID, callback) {
  // just the /oauth/auth*?query was passed in, let's parse it for the query string as a real url if it exists by using a fake foo.com prefix
  var origReqUrl = req.cookies && req.cookies.callback && urllib.parse("http://foo"+req.cookies.callback, true);
  if (!res.applied_flag) {
    // we can only succeed if we know where to redirect back to now
    if (!origReqUrl) return authfail(req, service, res, 'cookies disabled? missing required redirect :(', appID, callback);
    if (origReqUrl.query.scope) auth.scope = origReqUrl.query.scope; // nice to remember what was requested
    if (origReqUrl.query.account) auth.account = origReqUrl.query.account; // dep'd, TODO delete me once unused
  }
  logger.debug("FA ",service,auth,origReqUrl,res.applied_flag);
  logger.anubis(req,{act:'auth', app:appID, type:'auth', service:service, stage:'finish'});
  var self;
  if (auth && (auth.apiauth || res.self_flag)) {
    // the APIaaS incoming don't have synclets, just spoof a pass through, refactor this someday :)
    self = {};
    self.sync = function(arg, cb) {
      cb(null, arg);
    };
  }else{
    // local services load up the self synclet
    try {
      self = require(path.join('services', service, 'self.js'));
    } catch (E) {
      return authfail(req, service, res, E, appID, callback);
    }
  }
  self.sync({auth:auth, config:{}}, function(err, data){
    if (!err && (!data || !data.auth)) err = "no error or no profile data returned, or profile data missing auth field";
    if (err) logger.warn(err);
    if (err) return authfail(req, service, res, err, appID, callback);
    auth = data.auth; // has .profile now yay!
    logger.info('authorized %s, %s', auth.pid, appID);

    // There are three possibilities for an account ID to be provided in a call
    // to finishAuth:
    // 1. The caller provides it in auth.account
    // 2. Browser-based flow via /oauth/authorize (OLD)
    // 3. Browser-based flow via /oauth/authenticate (NEW)

    var accountID = false;
    if (auth.account) {
      // The caller of finishAuth provided an account ID already; use it
      accountID = auth.account;
      if (accountID === "false") accountID = false;
      logger.debug("Account ID via caller: " + accountID);

    } else if (origReqUrl) {

      // If the original destination was our NEW browser-entry point,
      // /oauth/authenticate, the account ID -- if any -- will be available in
      // the access_token query parameter.
      if (origReqUrl.pathname === "/oauth/authenticate") {
        if (origReqUrl.query.access_token) {
          try {
            accountID = tokenz.parseAccessToken(origReqUrl.query.access_token).account;
            logger.debug("Account ID via new flow: " + accountID);
          } catch(e) {
            return authfail(req, service, res, "Invalid OAuth access token.", appID, callback);
          }
        }
      } else {
        // Browser-based flow through our old endpoint, /oauth/authorize
        accountID = getACookie(req, appID).id;
        if (accountID === "false" || !accountID) accountID = false;
        logger.debug("Account ID via old flow: " + accountID);
      }
    }

    acl.getOrAdd(accountID, appID, auth.pid, function(err, account, count) {
      if (err) logger.error("failed to get|add ",err);
      if (err) return authfail(req, service, res, err, appID, callback);
      if (!account) return authfail(req, service, res, 'could not create a user', appID, callback);
      if (count > 1) logger.warn("multiple accounts for a profile!",appID,auth.pid); // TODO if no acookie.id enforce no logins on multi-accounts?
      if (!auth.accounts) auth.accounts = {};
      // the first time an account attaches to a profile, we run any default push for this app async in the background
      if (!auth.accounts[account.account]) {
        ijod.getOne('routes:'+appID+'/push#default', function(err, entry) {
          if (entry) {
            push.firstRun(entry.data, [auth.pid], function() {
              logger.info('finished running default push routes',auth.pid,entry.idr);
            });
          }
        });
      }
      // track every account associated to this profile and app, ALSO see
      // authMerge below does this
      auth.accounts[account.account] = Date.now();
      profileManager.authSet(auth.pid, auth, appID, function(err, newAuth) {
        instruments.increment("auth.successful."+service).send();
        // in background, save the new profile
        pipeline.inject(data.data, auth, function(err){
          if (err) logger.error('failed to save self',err);
        });
        // save auth, set up synclet tasks, and if this is a new auth and not a
        // batch import, forces immediate sync too
        taskman.taskUpdate(newAuth, function() {}, null, res.batch);
        if (res.applied_flag) {
          tokenz.createAccessToken(account.account, appID, {}, function(err, token){
            if (callback) return callback(null, token);
            res.json(token);
          });
          return;
        }
        // set/update the account-level sticky cookie for subsequent auths
        setACookie(res, {app:appID, id:account.account});
        return redirAppCallback(req, res, origReqUrl, account.account, appID, auth.pid);
      });
    });
  });
}

// just breaking this flow out since
function redirAppCallback(req, res, origURL, account, appID, pid)
{
  var redirect_uri = origURL.query.redirect_uri || origURL.query.redirect_url; // be friendly
  var state = origURL.query.state; // odd optional oauth thing
  var response_type = origURL.query.response_type || 'code';
  var service = origURL.query.service;

  // first verify the redirect_uri matches
  acl.getApp(appID, function(err, app){
    if (err || !app || app.length === 0) {
      logger.error("login, failed to find "+appID,err);
      return res.send('invalid client_id', 400);
    }

    // verify redirect_uri here is superset of the configured one
    function validate(saved, redir)
    {
      var ret = false;
      saved.split(' ').forEach(function(surl){
        if (redir.toLowerCase().indexOf(surl.toLowerCase()) === 0) ret = true;
      });
      return ret;
    }
    if (!app.notes || !app.notes.callbackUrl || !redirect_uri || !validate(app.notes.callbackUrl, redirect_uri)) {
      logger.warn("callback mismatch warning!", app.app, app.notes && app.notes.callbackUrl, redirect_uri);
      logger.anubis(req,{act:'auth', app:app.app, type:'autherror', service:service, error:'callback mismatch'});

      /* return res.send(
        "Unacceptable redirect_uri. If you are the developer, please check " +
        "<pre>" + sanitizer.escape(req.query.redirect_uri) + "</pre>" +
        " against your " +
        "<a href=\"https://singly.com/apps\">application settings</a>."
      ); */
    }

    // client-based requests, gen a token and serialize em out
    if (response_type === 'token') {
      tokenz.createAccessToken(account, appID, {}, function(err, token){
        res.redirect(redirect_uri + '#' +  querystring.stringify(token));
      });
      return;
    }

    // gotta generate a grant code and send it back to em
    if (response_type === 'code') {
      var code = crypto.createHash('md5').update(Math.random().toString() + Date.now().toString()).digest('hex')
      acl.addGrant(code, account, appID, pid, function(err){
        if (err) logger.error("save grant failed",err);
        var redir = urllib.parse(redirect_uri, true);
        redir.query.code = code;
        if (state) redir.query.state = state;
        delete redir.search;
        res.redirect(urllib.format(redir));
      });
      return;
    }

    res.send('invalid response_type, must be "code" or "token" and is: '+response_type);
  });
}

// utils to get/set or init the account cookie, using the same crypto keys as oauth
function getACookie(req, app) {
  var account = {app:app};
  if (req.cookies && req.cookies["account-"+app]) {
    try {
      account = tokenz.serializer.parse(req.cookies["account-"+app]);
    }catch(E){}
  }
  logger.debug("ACOOKIE get "+JSON.stringify(account));
  return account;
}
function setACookie(res, account) {
  logger.debug("ACOOKIE set "+JSON.stringify(account));
  var expirey = Date.now() + (lconfig.cookieExpire * 1000);
  var opaque = tokenz.serializer.stringify(account);
  res.cookie('account-'+account.app, opaque, { path: '/', httpOnly: true});
}

// this is /oauth/auth* service multiplexer redirector
exports.start = function(req, res) {
  var service = req.query.service;
  var appID = req.query.client_id;
  if (typeof service !== "string") return res.send('missing or invalid service: '+service, 400);
  if (typeof appID !== "string") return res.send('missing or invalid client_id: '+appID, 400);

  // first, verify client_id is an app we know about
  logger.debug("oauth start "+req.url,service,appID);
  // need a couple things stored on the session for post-auth
  res.cookie('callback', req.url, { path: '/', httpOnly: true});
  // fallback stash the app id on the browser, some stupid oauth's don't support callback (tumblr!)
  res.cookie('auth'+service, appID, { path: '/', httpOnly: true});
  return startServiceAuth(service, appID, req, res);
};

// merge the profiles from the source token to those in the dest (and delete the source)
exports.authMerge = function(source, dest, cbDone) {
  try {
    source = tokenz.parseAccessToken(source);
    source.account = source.user_id;
    source.app = source.client_id;
  } catch(e) {
    return cbDone("invalid source access token");
  }
  try {
    dest = tokenz.parseAccessToken(dest);
    dest.account = dest.user_id;
    dest.app = dest.client_id;
  } catch(e) {
    return cbDone("invalid dest access token");
  }

  logger.info("MERGING",source,dest);

  // return the full dest profile
  function done() {
    var ret = {};
    ret.id = dest.account;
    acl.getProfiles(dest.account, function(err, profiles) {
      if (err || !profiles || profiles.length === 0) return cbDone(null, ret);
      profiles.forEach(function(item){
        if (!item.profile || item.profile.indexOf('@') === -1) return;
        var parts = item.profile.split('@');
        if (!ret[parts[1]]) ret[parts[1]] = [];
        ret[parts[1]].push(parts[0]);
      });
      cbDone(null, ret);
    });
  }

  // loop through the profiles in the source
  acl.getProfiles(source.account, function(err, profiles) {
    if (err || !profiles || profiles.length === 0) return done();
    async.forEach(profiles, function(item, cbProfiles){
      if (!item.profile) return process.nextTick(cbProfiles);
      // actually add it
      acl.getOrAdd(dest.account, dest.app, item.profile, function() {
        // we also have to update the auth for this profile
        profileManager.authGet(item.profile, source.app, function(err, auth){
          if (err || !auth) {
            logger.warn("failed to get auth for ",item.profile,err);
            return cbProfiles();
          }

          // see finishAuth above that does this too
          delete auth.accounts[source.account];
          auth.accounts[dest.account] = Date.now();

          // save updated auth out
          profileManager.authSet(item.profile, auth, dest.app, cbProfiles);
        });
      });
    }, function(){
      acl.delProfiles(source.account, done);
    });
  });
};
