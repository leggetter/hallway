var express = require('express');
var connect = require('connect');
var logger = require('logger').logger('dawg');
var async = require('async');
var crypto = require('crypto');
var taskStore = require('taskStore');
var taskman = require('taskman');
var profileManager = require('profileManager');
var ijod = require('ijod');
var pipeline = require('pipeline');
var acl = require('acl');
var instruments = require("instruments");
var lconfig = require('lconfig');
var dal = require('dal');
var alerting = require('alerting');
var request = require('request');
var serializer = require('serializer').createSecureSerializer(
  lconfig.authSecrets.crypt, lconfig.authSecrets.sign);
var aws = require('dawg-aws');
var _ = require('underscore');
var authManager = require('authManager');
var querystring = require('querystring');

var apiHostArray = [];
var workerArray = [];
var globals = { ijodtotal: 0, ijodlast: 0, ijodcache: [] };

var HOUR_IN_MS = 60 * 60 * 1000;

// TODO: Why isn't this list dynamically generated?
var services = [
  'facebook',
  'fitbit',
  'foursquare',
  'gcontacts',
  'github',
  'gmail',
  'google',
  'instagram',
  'linkedin',
  'meetup',
  'runkeeper',
  'tumblr',
  'twitter',
  'withings',
  'wordpress',
  'yammer',
  'zeo'
];

// TODO: Replace with Singly authentication
function authorize(user, pass) {
  if (!lconfig.dawg || !lconfig.dawg.password) return false;
  var ret = 'dawg' === user && pass === lconfig.dawg.password;
  return ret;
}

function appDetail(key, callback) {
  if (!key) return callback();

  dal.query("SELECT * FROM Apps WHERE app = ? LIMIT 1", [key],
    function (err, ret) {
    if (err) {
      return callback(err);
    }

    if (!ret || !ret[0]) {
      return callback(null, {});
    }

    // The query is LIMIT 1 so there's only one row
    ret = ret[0];

    if (ret.apikeys) {
      try {
        ret.apikeys = JSON.parse(ret.apikeys);
      } catch(e) {
      }
    }

    if (ret.notes) {
      try {
        ret.notes = JSON.parse(ret.notes);
      } catch(e) {
        return callback(null, ret);
      }

      var idr = 'profile:' + ret.notes.account +
        '@singly-dev-registration/self#' + ret.notes.account;

      ijod.getOne(idr, function(err, profile) {
        if (!err && profile) {
          ret.profile = profile;
        }

        callback(null, ret);
      });
    } else {
      callback(null, ret);
    }
  });
}

function getCountBefore(since, callback) {
  var appSince = '';
  var binds = [];

  var sql = 'SELECT COUNT(DISTINCT Accounts.account) AS accountCount, ' +
            'Accounts.app FROM Accounts ';
  if (since) {
    sql += ' WHERE Accounts.cat < FROM_UNIXTIME(?) OR Accounts.cat IS  NULL';
    binds.push(since);
  }

  sql += ' GROUP BY Accounts.app';
  dal.query(sql, binds, function(err, rows) {
    var info = {};
    if (err || !rows || !rows.length) return callback(err, rows);
    for (var i in rows) {
      var row = rows[i];
      info[row.app] = parseInt(row.accountCount, 10);
    }
    return callback(null, info);
  });
}

function appCounts(req, res, options) {
  var binds = [];

  var appId = '';
  var appSince = '';
  var accountSince = '';

  if (req.query.appSince) {
    appSince = "AND Apps.cat > FROM_UNIXTIME(?) ";

    binds.push(req.query.appSince);
  }

  if (req.query.accountSince) {
    accountSince = "AND Accounts.cat > FROM_UNIXTIME(?) ";

    binds.push(req.query.accountSince);
  }

  if (req.query.id) {
    appId = "AND Apps.app = ? ";

    binds.push(req.query.id);
  }

  var sql = "SELECT " +
      "COUNT(DISTINCT Accounts.account) AS accountCount, " +
      "COUNT(Accounts.account) AS profileCount, " +
      "Apps.app, Apps.notes, Apps.cat, SUBSTRING_INDEX(GROUP_CONCAT(DISTINCT Accounts.account),',',5) as accountList " +
      "FROM Accounts, Apps " +
      "WHERE Apps.app = Accounts.app " +
      appSince +
      accountSince +
      appId +
      "GROUP BY Apps.app";

  dal.query(sql, binds, function(err, accounts) {
    if (err) {
      logger.error('dal.query error', err);
      return res.json(err, 500);
    }

    if (!accounts || accounts.length === 0) {
      return res.json([], 404);
    }

    var ret = [];

    var daysAgo = Math.floor((Date.now() - (7 * 24 * 60 * 60 * 1000))/1000);
    //var daysAgo = Math.floor((Date.now() - (30 * 60 * 1000))/1000);

    getCountBefore(daysAgo, function(err, accountsBefore) {
      async.forEach(accounts, function(account, cbForEach) {
        if (!options || !options.details) {
          try {
            account.notes = JSON.parse(account.notes);
          } catch(e) {
          }

          ret.push({
            id: account.app,
            created: account.cat,
            accounts: parseInt(account.accountCount, 10),
            accountsBefore: accountsBefore[account.app],
            profiles: parseInt(account.profileCount, 10),
            accountList: (account.accountList || "").split(','),
            details: {
              notes: account.notes
            }
          });

          return process.nextTick(cbForEach);
        }

        appDetail(account.app, function(err, details) {
          if (err || !details) {
            details = {};
          }

          ret.push({
            id: account.app,
            created: account.cat,
            accounts: parseInt(account.accountCount, 10),
            details: details
          });

          cbForEach();
        });
      }, function() {
        res.json(ret);
      });
    });
  });
}

function findEmailFromArray(arr) {
  for(var i in arr) {
    if (arr[i] && arr[i].email) return arr[i].email;
  }
}


function getEmailFromProfile(profile) {
  var eml;
  if (profile.facebook) {
    eml = findEmailFromArray(profile.facebook);
    if (eml) return eml;
  }
  if (profile.github) {
    eml = findEmailFromArray(profile.github);
    if (eml) return eml;
  }
}

function getAccountFromClientID(client_id, callback) {
  appDetail(client_id, callback);
}

function getAppInfoFromAccountID(account_id, callback) {
  dal.query("select app, account, profile from Accounts where account = ?",
    [account_id], function(err, profiles) {
    if (err) return callback(err, profiles);
    if (!profiles || profiles.length === 0) return callback(null, {});
    var ret = {};
    ret.app = profiles[0].app;
    ret.id = profiles[0].account;
    ret.profiles = [];
    ret.token = serializer.stringify([ret.id, ret.app, +new Date(), null]);
    profiles.forEach(function(row) {
      ret.profiles.push(row.profile);
    });
    return callback(null, ret);
  });
}

function getAppInfoFromNotes(note, callback) {
  var query = 'SELECT app, notes, cat FROM Apps WHERE notes LIKE ?';
  var values = ['%'+note+'%'];
  dal.query(query, values, function(err, results) {
    if (err) return callback(err);
    callback(null, results);
  });
}

function getAppOwnerAccessTokenFromAccountID(account_id, callback) {
  getAppInfoFromAccountID(account_id, function(err, body) {
    if (err) return callback(err, body);
    return callback(null, body.token);
  });
}

var PROFILES_URL = lconfig.externalBase + '/profiles';

function getEmailFromAccessToken(access_token, callback) {
  if (!Array.isArray(access_token)) access_token = [access_token];
  var results = {};
  var errs;
  async.forEach(access_token, function(atok, cbEach) {
    // talk to our API to get the profile
    request.get({
      uri: PROFILES_URL,
      qs: {
        access_token: atok,
        data: true
      },
      json: true
    }, function(err, resp, profile) {
      if (!err && !profile) err = new Error('no profile for access_token');
      if (!err && profile) {
        var email = getEmailFromProfile(profile);
        if (!email) err = new Error('no email for access_token');
        results[atok] = email;
      }
      if (err) {
        // collect errors (and resp bodies) and deal with them at the end
        if (!errs) errs = {};
        errs[atok] = err;
        results[atok] = profile;
      }
      return cbEach();
    });
  }, function(err) {
    callback(errs, results);
  });
}

function getAppInfoFromClientID(client_id, callback) {
  getAccountFromClientID(client_id, function(err, acct) {
    if (!acct || !acct.notes) return callback(new Error('no account returned ' +
      'for client_id'), acct);
    var info = {
      name: acct.notes.appName,
      description: acct.notes.appDescription,
      url: acct.notes.appUrl,
      callback: acct.notes.callbackUrl
    };
    if (acct.profile && acct.profile.data && acct.profile.data.email) {
      info.email = acct.profile.data.email;
      return callback(null, info);
    }
    if (acct.notes && acct.notes.account) {
      return getAppOwnerAccessTokenFromAccountID(acct.notes.account,
        function(err, ao_access_token) {
        if (err) return callback(err, ao_access_token);
        return getEmailFromAccessToken(ao_access_token, function(err, email) {
          if (err) return callback(err, {account: acct, email:email});
          info.email = email[ao_access_token];
          return callback(null, info);
        });
      });
    }
    return callback(new Error('account doesn\'t have a profile or notes field',
      acct));
  });
}

function getClientIDFromAccessToken(atok, callback) {
  var clientID;
  try {
    clientID = authManager.provider.parseAccessToken(atok).client_id;
  } catch(E) {
    return callback(new Error("Invalid access token", atok));
  }
  return callback(null, clientID);
}

function getAppInfoFromUserAccessToken(access_token, callback) {
  getClientIDFromAccessToken(access_token, function(err, client_id) {
    if (err) return callback(err, client_id);
    getAppInfoFromClientID(client_id, callback);
  });
}

var dawg = express.createServer(
  connect.bodyParser(),
  connect.cookieParser(),
  function(req, res, next) {
    logger.debug("REQUEST %s", req.url);
    next();
  },
  // enable CORS
  function(req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "X-Requested-With, " +
      "Authorization");

    // intercept OPTIONS method for CORS
    if (req.method === 'OPTIONS') {
      res.send(200);

      return;
    }

    next();
  },
  function(req, res, next) {
    if (req.url === '/apple-touch-icon.png') return next();
    express.basicAuth(authorize)(req, res, next);
  }
);

dawg.get('/customers/languages', function(req, res) {
  var sql = 'SELECT Accounts.account, Accounts.profile ' +
    'FROM Accounts ' +
    'INNER JOIN Profiles ' +
      'ON Accounts.profile = Profiles.id ' +
    'WHERE Accounts.app = "singly-dev-registration" ' +
      'AND Profiles.service = "github"';

  var options = {
    limit: 100,
    offset: 0
  };

  var counts = {};

  // XXX: This takes forever
  res.connection.setTimeout(0);

  dal.query(sql, [], function(err, result) {
    async.forEachLimit(result, 10, function(row, forEachCb) {
      var base = 'repo:' + row.profile + '/repos';

      ijod.getRange(base, options, function(item) {
        if (counts[item.data.language] === undefined) {
          counts[item.data.language] = 0;
        }

        counts[item.data.language] += 1;
      }, function(err) {
        logger.info('done', err);

        forEachCb();
      });
    }, function(err) {
      counts = _.map(counts, function(v, k) {
        return {
          id: k,
          count: v
        };
      });

      counts = _.sortBy(counts, function(language) {
        return -language.count;
      });

      res.json(counts);
    });
  });
});

dawg.get('/customers/likes', function(req, res) {
  var sql = 'SELECT Accounts.account, Accounts.profile ' +
    'FROM Accounts ' +
    'INNER JOIN Profiles ' +
      'ON Accounts.profile = Profiles.id ' +
    'WHERE Accounts.app = "singly-dev-registration" ' +
      'AND Profiles.service = "facebook"';

  var options = {
    limit: 1500,
    offset: 0
  };

  var counts = {};

  // XXX: This takes forever (~10 minutes) and should be moved into a
  // "report" framework
  res.connection.setTimeout(0);

  dal.query(sql, [], function(err, result) {
    async.forEachLimit(result, 10, function(row, forEachCb) {
      async.series([
        function(seriesCb) {
          var urlBase = 'url:' + row.profile + '/url_likes';

          ijod.getRange(urlBase, options, function(item) {
            if (counts[item.data.url] === undefined) {
              counts[item.data.url] = 0;
            }

            counts[item.data.url] += 1;
          }, function(err) {
            logger.info('done', err);

            seriesCb(err);
          });
        },
        function(seriesCb) {
          var pageBase = 'page:' + row.profile + '/page_likes';

          ijod.getRange(pageBase, options, function(item) {
            if (counts[item.data.name] === undefined) {
              counts[item.data.name] = 0;
            }

            counts[item.data.name] += 1;
          }, function(err) {
            logger.info('done', err);

            seriesCb(err);
          });
        }
      ],
      function(err) {
        forEachCb();
      });
    }, function(err) {
      counts = _.map(counts, function(v, k) {
        return {
          id: k,
          count: v
        };
      });

      counts = _.sortBy(counts, function(like) {
        return -like.count;
      });

      res.json(counts);
    });
  });
});

dawg.get('/aws/estimatedCharges', function(req, res) {
  aws.estimatedCharges(function(err, charges) {
    if (err || !charges) {
      return res.json(err, 500);
    }

    res.json(charges);
  });
});

dawg.get('/aws/counts', function(req, res) {
  aws.instanceCounts(function(err, counts) {
    if (err || !counts) {
      return res.json(err, 500);
    }

    res.json(counts);
  });
});

var redis;
dawg.get('/stats/redis', function(req, res) {
  if(!redis) redis = require('redis').createClient(lconfig.taskman.redis.port,
    lconfig.taskman.redis.host);
  var ret = {};
  redis.select(1, function() {
    redis.hlen("active", function(err, active) {
      if(err) return res.json(err,500);
      ret.active = active;
      redis.scard("next", function(err, next) {
        if(err) return res.json(err,500);
        ret.next = next;
        redis.scard("dirty", function(err, dirty) {
          if(err) return res.json(err,500);
          ret.dirty = dirty;
          redis.info(function(err, info) {
            ret.info = {};
            info.split(/\s+/).forEach(function(pair){
              var kv = pair.split(":");
              ret.info[kv[0]] = kv[1];
            });
            res.json(ret);
          });
        });
      });
    });
  });
});

dawg.get('/stats/ijod', function(req, res) {
  // calculated every 10min below
  res.json({count:globals.ijodtotal});
});

dawg.get('/stats/bam', function(req, res) {
  // calculated every 10min below
  res.json({AppsPerProfile:globals.app, ProfilesPerAccount:globals.ppa});
});

dawg.get('/accounts/total', function(req, res) {
  var sql = "SELECT COUNT(DISTINCT account) AS accountCount FROM Accounts";

  var binds = [];

  if (req.query.until) {
    sql += " WHERE Accounts.cat <= FROM_UNIXTIME(?) ";

    binds.push(req.query.until);
  }

  dal.query(sql, binds, function(err, ret) {
    if (err) {
      return res.json(err, 500);
    }

    if (!ret || !ret[0]) {
      return res.json({});
    }

    res.json({ total: parseInt(ret[0].accountCount, 10) });
  });
});

dawg.get('/profiles/total', function(req, res) {
  var sql = "SELECT COUNT(id) AS profileCount FROM Profiles";

  var binds = [];

  if (req.query.until) {
    sql += " WHERE Profiles.cat <= FROM_UNIXTIME(?) ";

    binds.push(req.query.until);
  }

  dal.query(sql, binds, function(err, ret) {
    if (err) {
      return res.json(err, 500);
    }

    if (!ret || !ret[0]) {
      return res.json({});
    }

    res.json({ total: parseInt(ret[0].profileCount, 10) });
  });
});

dawg.get('/profiles/breakdown', function(req, res) {
  var sql = "select service, count(*) as cnt from Profiles ";
  var binds = [];
  if (req.query.since) {
    sql += " where cat > from_unixtime(?) ";
    binds.push(req.query.since);
  }
  sql += " group by service";
  dal.query(sql, binds, function(err, ret) {
    if (err) return res.json(err, 500);
    if (!ret || !ret[0]) return res.json({});
    var ndx = {};
    ret.forEach(function(row) {
      if (row.service && row.service.length > 0) {
        ndx[row.service] = row.cnt;
      }
    });
    res.json(ndx);
  });
});

dawg.get('/profiles/get', function(req, res) {
  if (!req.query.pid) return res.json("missing ?pid=id@service",500);
  profileManager.allGet(req.query.pid, function(err, ret) {
    if (err) return res.json(err, 500);
    dal.query("select app, account from Accounts where profile = ?",
      [req.query.pid], function(err, apps) {
      if (err) return res.json(err, 500);
      if (apps) apps.forEach(function(app) {
        app.token = serializer.stringify([app.account, app.app, +new Date(),
          null]);
      });
      ret.apps = apps;
      res.json(ret);
    });
  });
});

dawg.get('/profiles/search', function(req, res) {
  if (!req.query.q) return res.json("missing ?q=foo",500);
  dal.query("select id, cat from Profiles where auth like ? limit 100",
      ['%'+req.query.q+'%'], function(err, ret) {
    if (err) return res.json(err, 500);
    if (!ret || !ret[0]) return res.json([]);
    res.json(ret);
  });
});

function idhex(id) {
  return crypto.createHash('md5').update(id).digest('hex');
}

dawg.get('/profiles/note', function(req, res) {
  if (!req.query.pid) return res.json("missing ?pid=id@service",500);
  if (!req.query.note) return res.json("missing ?note=this+is+my+note",500);
  logger.anubis(req,{act:idhex(req.query.pid), app:'singly', type:'note',
    note:req.query.note});
  res.json(true);
});

dawg.get('/profiles/notes', function(req, res) {
  var id = (req.query.pid) ? idhex(req.query.pid)+'@' : '';
  var base = 'logs:'+id+'singly/anubis';
  var ret = [];
  var options = {};
  if (req.query.offset) options.offset = parseInt(req.query.offset, 10) || 0;
  options.limit = parseInt(req.query.limit || 20, 10);
  ijod.getRange(base, options, function(item) {
    ret.push(item);
  },
    function(err) {
    res.send(ret);
  });
});

dawg.get('/profiles/tasks', function(req, res) {
  if (!req.query.pid) return res.json("missing ?pid=id@service", 500);
  taskStore.getTasks(req.query.pid, function(err, tasks) {
    if (err) return res.json(err, 500);
    res.json(tasks);
  });
});

dawg.get('/profiles/retask', function(req, res) {
  if (!req.query.pid) return res.json("missing ?pid=id@service", 500);
  profileManager.authGet(req.query.pid, null, function(err, auth) {
    if(!auth) return res.json(err);
    taskman.taskUpdate(auth, function(err) {
      if(err) return res.json(err);
      res.json(true);
    }, req.query.force);
  });
});

dawg.get('/profiles/detask', function(req, res) {
  if (!req.query.pid) return res.json("missing ?pid=id@service", 500);
  taskStore.detask(req.query.pid, function(err) {
    if(err) return res.json(err);
    res.json(true);
  });
});

dawg.get('/run/:pid', function(req, res) {
  var pids = req.params.pid;
  if (!pids) return res.send('need pids!', 400);
  pids = pids.split(',');
  if (!Array.isArray(pids)) return res.send('pid split didn\'t work!', 500);
  async.forEachSeries(pids, function(pid, cb) {
    taskman.syncForce(pid, function(err, tasks){
      if (err) return cb(err);
      setTimeout(cb, 1000);
    });
  }, function(err) {
    if(err) return res.json(err, 500);
    res.json({});
  });
});

dawg.post('/syncNow', function(req, res) {
  var pid = req.param('pid');
  var synclet = req.param('synclet');
  taskman.syncNow(pid, synclet, function() {
    res.send('ok');
  });
});

dawg.get('/account/apps', function(req, res) {
  if (!req.query.key) {
    return res.json('missiong ?key=foo', 500);
  }
  getAppInfoFromNotes(req.query.key, function(err, results) {
    if (err) return res.send(500);
    else res.json(results);
  });
});

// Return information about a specific app given its key
dawg.get('/apps/get', function(req, res) {
  if (!req.query.key) {
    return res.json("missing ?key=foo", 500);
  }

  // this also resets memcache to current always
  acl.getApp(req.query.key, function(){}, true);

  appDetail(req.query.key, function(err, result) {
    if (err || !result)
      return res.json(err, 500);

    res.json(result);
  });
});

dawg.get('/apps/logs', function(req, res) {
  if (!req.query.key) return res.json("missing ?key=foo",500);
  var base = 'logs:'+req.query.key+'/anubis';
  var ret = [];
  var options = {};
  if (req.query.offset) options.offset = parseInt(req.query.offset, 10) || 0;
  options.limit = parseInt(req.query.limit || 20, 10);
  options.q = req.query.q;
  ijod.getRange(base, options, function(item) { ret.push(item); },
    function(err) {
    res.send(ret);
  });
});

dawg.get('/apps/account', function(req, res) {
  if (!req.query.id) return res.json("missing ?id=a23512b4234",500);
  dal.query("select app, account, profile from Accounts where account = ?",
    [req.query.id], function(err, profiles) {
    if (err) return res.json(err, 500);
    if (!profiles || profiles.length === 0) return res.json({},404);
    var ret = {};
    ret.app = profiles[0].app;
    ret.id = profiles[0].account;
    ret.profiles = [];
    ret.token = serializer.stringify([ret.id, ret.app, +new Date(), null]);
    profiles.forEach(function(row) {
      ret.profiles.push(row.profile);
    });
    if (ret.app !== 'singly-dev-registration') return res.json(ret);

    // singly.com account -- lookup apps
    getAppInfoFromNotes(ret.id, function(err, apps) {
      if (err) {
        logger.warn(err);
        return res.json(err);
      }
      ret.apps = {};
      apps.forEach(function(app) {
        var appNotes;
        try {
          appNotes = JSON.parse(app.notes);
        } catch(e) {
          appNotes = 'cannot parse JSON';
        }
        ret.apps[app.app] = appNotes;
      });
      return res.json(ret);
    });
  });
});

dawg.get('/proxy/:account/*', function(req, res) {
  var account = req.param('account');
  dal.query("select app, account, profile from Accounts where account = ?", [account], function(err, profiles) {
    if (err) return res.json(err, 500);
    if (!profiles || profiles.length === 0) return res.json({},404);
    var url = 'https://api.singly.com/'+req.params[0];
    logger.info("proxying",account,url,req.query);
    req.query.access_token = serializer.stringify([account, profiles.app, +new Date()]);
    request.get({url:url, qs:req.query, json:true}).pipe(res);
  });
});

dawg.get('/apps/accounts', appCounts);

dawg.get('/devs', function(req, res) {
  var sql = "SELECT COUNT(DISTINCT Accounts.account) AS accountCount, " +
    "DATE(Accounts.cat) AS day, Apps.app, Apps.notes, Apps.cat " +
    "FROM Accounts, Apps " +
    "WHERE Apps.app = Accounts.app " +
    "AND Apps.app='singly-dev-registration' " +
    "GROUP BY day";

  dal.query(sql, [], function(err, developers) {
    if (err) {
      return res.json(err, 500);
    }
    res.json(developers);
  });
});

dawg.get('/appsbyservice', function(req, res) {
  var sqlBase = "SELECT COUNT(DISTINCT app) FROM Accounts WHERE profile LIKE ";
  var table = {};

  async.forEach(services, function(service, cb) {
    var sql = sqlBase + "'%" + service + "%'";
    dal.query(sql, [], function(err, result) {
      if (err) {
        return res.json(err, 500);
      }
      table[service] = result[0]["COUNT(DISTINCT app)"];
      cb(null);
    });
  }, function(err) {
    res.json(table);
  });
});

dawg.get('/appsbyday', function(req, res) {
  var sql = 'SELECT DATE(cat) AS day, COUNT(app) AS appCount ' +
   'FROM Apps ' +
   'GROUP BY day';

  dal.query(sql, [], function(err, apps) {
    if (err) {
      return res.json(err, 500);
    }
    res.json(apps);
  });
});

dawg.get('/productionappsbyday', function(req, res) {
  var sql = "SELECT DATE(cat) AS day, COUNT(app) AS appCount, GROUP_CONCAT(app, ',') AS apps " +
   "FROM Apps " +
   "WHERE apikeys IS NOT NULL " +
   "AND apikeys != '{}' " +
   "GROUP BY day";

  dal.query(sql, [], function(err, apps) {
    if (err) {
      return res.json(err, 500);
    }
    res.json(apps);
  });
});

dawg.get('/productionappsactive', function(req, res) {
  var days = req.query.days || 7;
  var under = req.query.under || 50;
  var sql = "select Accounts.app as app, count(*) as cnt from Accounts right join Apps on Apps.app = Accounts.app where Apps.apikeys is not NULL and Accounts.cat > DATE_SUB(NOW(), INTERVAL ? day) GROUP BY Accounts.app HAVING cnt < ?";

  dal.query(sql, [days, under], function(err, apps) {
    if (err) return res.json(err, 500);
    res.json(apps);
  });
});

dawg.get('/invoicestester', function(req, res) {
  res.render('invoicestester');
});

function apiHostState(cb) {
  var apiHosts = [];
  var unresponsive = [];

  async.forEach(apiHostArray, function(apiHost, cbForEach) {
    var ip = apiHost.publicIp;

    if (process.env.NODE_ENV === 'production') {
      ip = apiHost.privateIp;
    }

    request.get({
      uri: 'http://' + ip + ':8042/state',
      json: true,
      timeout: 5000
    }, function(err, res, js) {
      if (err && err.code === 'ETIMEDOUT') {
        unresponsive.push(ip);

        return cbForEach();
      }

      if (typeof js !== 'object') {
        return cbForEach();
      }

      js.publicIp = apiHost.publicIp;
      js.privateIp = apiHost.privateIp;

      apiHosts.push(js);

      cbForEach();
    });
  }, function() {
    cb({
      apiHosts: apiHosts,
      unresponsive: unresponsive
    });
  });
}

var BACKLOG = {};
function workerState(cb) {
  var active = 0;
  var workers = [];
  var unresponsive = [];

  async.forEach(workerArray, function(worker, cbForEach) {
    var ip = worker.publicIp;

    if (process.env.NODE_ENV === 'production') {
      ip = worker.privateIp;
    }

    request.get({ uri: 'http://' + ip + ':8041', json: true, timeout: 5000 },
      function(err, res, js) {
      if (err && err.code === 'ETIMEDOUT') {
        unresponsive.push(worker.publicIp);

        return cbForEach();
      }

      if (typeof js !== 'object') {
        return cbForEach();
      }

      js.publicIp = worker.publicIp;
      js.privateIp = worker.privateIp;

      workers.push(js);

      active += js.active.length;

      cbForEach();
    });
  }, function() {
    cb({
      active: active,
      backlog: BACKLOG.total,
      oldest: BACKLOG.oldest,
      bases: BACKLOG.bases,
      workers: workers,
      unresponsive: unresponsive
    });
  });
}

dawg.get('/workers/state', function(req, res) {
  workerState(function(state) {
    res.json(state);
  });
});

dawg.get('/apiHosts/state', function(req, res) {
  apiHostState(function(state) {
    res.json(state);
  });
});

dawg.get('/taskCount', function(req, res) {
  var since = 1, until = Date.now();
  if (req.query.hour !== null && req.query.hour !== undefined) {
    var hour = parseInt(req.query.hour, 10) * 3600 * 1000;
    since = Date.now() + hour;
    until = since + (3600*1000);
  } else {
    if (req.query.since) {
      try {
        since = parseInt(req.query.since, 10);
      } catch(err) { }
    }
    if (req.query.until) {
      try {
        until = parseInt(req.query.until, 10);
      } catch(err) { }
    }
  }
  taskStore.taskCount(since, until, function(err, taskCount) {
    if (err) return res.json(err, 500);
    return res.json(taskCount);
  });
});

dawg.get('/onetime/pid2task', function(req, res) {
  logger.info("running onetime pid2task");
  dal.query("select id from Profiles", [], function(err, ret) {
    if(err || !ret) return res.send(err, 500);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write("doing "+ret.length+"\n");
    async.forEachLimit(ret, 15, function(row, cbLoop) {
      res.write(row.id+"\n");
      profileManager.authGet(row.id, null, function(err, auth) {
        if(!auth) return cbLoop();
        taskman.taskUpdate(auth, function(err) {
          if(err) res.write([row.id,err,'\n'].join(' '));
          cbLoop();
        }, req.query.force);
      });
    }, function(err) {
      if(err) res.write(err.toString());
      res.end();
    });
  });
});

dawg.get('/onetime/taskscan', function(req, res) {
  logger.info("running onetime taskscan");
  dal.query("select id from Profiles", [], function(err, ret) {
    if(err || !ret) return res.send(err, 500);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write("doing "+ret.length+"\n");
    async.forEachSeries(ret, function(row, cbLoop) {
      if(req.query.service && row.id.indexOf(req.query.service) === -1) {
        return process.nextTick(cbLoop);
      }
      res.write(row.id+"\n");
      redis.sadd("next", row.id, cbLoop);
    }, function(err) {
      if(err) res.write(err.toString());
      res.end();
    });
  });
});

dawg.get('/links/:type', function(req, res) {
  // Prevent a very expensive query
  if (!req.query.q || req.query.q === '') {
    return res.json([]);
  }

  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.write('[');

  var options = {};

  if (req.query.offset) options.offset = parseInt(req.query.offset, 10) || 0;

  options.limit = parseInt(req.query.limit || 20, 10);
  options.q = req.query.q;

  var written = 0;

  ijod.getRange(req.params.type + ':links/oembed', options, function(item) {
    if (written > 0) res.write(',');

    written++;

    // given the map flag, try to map any known fields
    res.write(JSON.stringify(item));
  }, function(err) {
    if (err) logger.error('error sending results for links:',err);

    return res.end(']');
  });
});

function activeApps(opt_since, cb) {
  var start = Date.now();

  var options = {
    since: Date.now() - (31556926 * 1000)
  };

  if (parseInt(opt_since, 10)) {
    options.since = parseInt(opt_since, 10);
  }

  logger.debug('activeApps called with since of ' + options.since);

  acl.getApps(function(err, all) {
    if (err || !all) {
      return cb(err);
    }

    var count = 0;
    var total = 0;

    var hits = {
      apps: []
    };

    async.forEachLimit(all, 10, function(row, cbForEach) {
      ijod.getBounds('logs:' + row.app + '/anubis', options,
        function(err, bounds) {
        if (!bounds || !bounds.total) {
          return cbForEach();
        }

        // The number of active apps
        count++;

        // The total number of hits among all apps
        total += bounds.total;

        appDetail(row.app, function(err, details) {
          // The hits for one app
          hits.apps.push({
            id: row.app,
            hits: bounds.total,
            details: details
          });

          cbForEach();
        });
      });
    }, function() {
      var duration = Date.now() - start;

      logger.debug('activeApps with since of ' + options.since + ' finished in ' + duration / 1000 + 's');

      hits.total = total;

      cb(null, count, hits);
    });
  });
}

dawg.get('/apps/active', function(req, res) {
  activeApps(req.query.since, function(err, count) {
    if (err) {
      return res.json(err, 500);
    }

    res.json(count);
  });
});

dawg.get('/apps/hits', function(req, res) {
  activeApps(req.query.since, function(err, count, hits) {
    if (err) {
      return res.json(err, 500);
    }

    res.json(hits);
  });
});

// Get a system-wide id uniquely
dawg.get('/id/:id', function(req, res) {
  var id = req.params.id || req.url.substr(1);
  ijod.getOne(id, function(err, entry) {
    if (err) logger.warn(err);
    if (!entry) return res.json("not found",404);
    res.json(entry);
  });
});

// error handling
dawg.error(function(err, req, res, next) {
  if (err.stack) logger.error(err.stack);
  res.json(err, 500);
});

function updateApiHostArray() {
  aws.instanceAddresses('apihost', function(err, addresses) {
    apiHostArray = addresses;
  });
}

function updateWorkerArray() {
  aws.instanceAddresses('worker', function(err, addresses) {
    workerArray = addresses;
  });
}

function updateBacklog() {
  logger.debug("Updating backlog");

  var start = Date.now();

  taskman.backlog(function (data) {
    BACKLOG = data;

    instruments.gauge({ 'workers.backlog': data.total }).send();

    var duration = Date.now() - start;

    instruments.timing({ 'taskman.backlog': duration }).send();

    logger.debug("Updating backlog took " + (duration / 1000) + "s");

    setTimeout(updateBacklog, 60000);
  });
}

function ijodCounter() {
  dal.query("SHOW TABLE STATUS LIKE 'Entries'", [], function(err, ret) {
    if (err || !ret || !ret[0]) return;
    globals.ijodlast = globals.ijodtotal;
    globals.ijodcache.unshift(parseInt(ret[0].Rows, 10));
    globals.ijodcache = globals.ijodcache.slice(0,60);
    var cnt = 0;
    var tot = 0;
    globals.ijodcache.forEach(function(rows) {cnt++; tot += rows;});
    globals.ijodtotal = parseInt(tot / cnt, 10);
  });
}

function appAccountProfiles(cb) {
  dal.query("select avg(sq1.cnt) as app, avg(sq2.cnt) as ppa from " +
    "(select count(*) as cnt from Accounts group by profile) as sq1, " +
    "(select count(*) as cnt from Accounts group by account) as sq2", [],
    function(err, ret) {
    if (ret && ret[0]) {
      globals.app = ret[0].app;
      globals.ppa = ret[0].ppa;
    }

    cb(err, ret && ret[0]);
  });
}

exports.startService = function(port, ip, cb) {
  dawg.listen(port, ip, function() {
    acl.init(function(){
      cb(dawg);      
    });
  });

  updateApiHostArray();
  updateWorkerArray();

  // Update the instance arrays from EC2 every 5 minutes
  setInterval(updateApiHostArray, 5 * 60 * 1000);
  setInterval(updateWorkerArray, 5 * 60 * 1000);

  updateBacklog();

  // Minutelies
  setInterval(function() {
    workerState(function(status) {
      if (typeof status !== 'object') {
        return;
      }

      instruments.gauge({
        'workers.active': status.active
      }).send();
    });
  }, 60000);

  // things that don't change much day-to-day
  setInterval(function() {
    appAccountProfiles(function(err, accountProfiles) {
      if (err || !accountProfiles) {
        return;
      }

      instruments.gauge({
        'bam.appsperprofile': accountProfiles.app,
        'bam.profilesperaccount': accountProfiles.ppa
      }).send();
    });
  }, 3600 * 6 * 1000);

  appAccountProfiles(function(err, accountProfiles) {
    if (err || !accountProfiles) {
      return;
    }

    instruments.gauge({
      'bam.appsperprofile': accountProfiles.app,
      'bam.profilesperaccount': accountProfiles.ppa
    }).send();
  });

  // 10-secondlys
  setInterval(function() {
    ijodCounter();
  }, 10000);

  ijodCounter();
};

function getAppInfoFromUserAccessTokens(tokens, callback) {
  var allInfo = {};
  async.forEach(tokens, function(token, cbEach) {
    getAppInfoFromUserAccessToken(token, function(err, info) {
      if (!err) allInfo[token] = info;
      cbEach();
    });
  }, function(err) {
    var result = {};
    _.each(allInfo, function(info, token) {
      var slug = JSON.stringify(info);
      if (!result[slug]) {
        result[slug] = info;
        result[slug].tokens = [];
      }
      result[slug].tokens.push(token);
    });
    callback(err, _.map(result, function(info, slug) {
      info.tokenCount = info.tokens.length;
      return info;
    }));
  });
}

dawg.get('/app/info', function(req, res) {
  var tokens = req.param('access_tokens') || req.param('access_token');
  tokens = tokens.split(',');
  getAppInfoFromUserAccessTokens(tokens, function(err, allInfo) {
    if (err) {
      res.json({err: err.toString()});
    } else {
      res.json(allInfo);
    }
  });
});

dawg.get('/app/info/:client_id', function(req, res) {
  getAppInfoFromClientID(req.params.client_id, function(err, appInfo) {
    if (err) return res.json(err, 500);
    res.json(appInfo);
  });
});

var PAPERTRAIL_BASE = 'https://papertrailapp.com/api/v1';
var PAPERTRAIL_SEARCH = PAPERTRAIL_BASE + '/events/search';

function searchLogs(token, query, params, callback) {
  if (typeof(params) === 'function') {
    callback = params;
    params = {};
  }
  params.q = query;

  request.get(PAPERTRAIL_SEARCH, {
    qs: params,
    headers: {
      'X-Papertrail-Token': token
    },
    json: true
  }, function(err, response, logs) {
    return callback(err, logs);
  });
}

function searchLogsSince(time, token, query, options, callback) {
  var allLogs = [];

  function fillLogs(err, logs) {
    if (err) return callback(err);

    allLogs = allLogs.concat(logs.events);

    var earliest = Date.parse(logs.min_time_at);
    if (earliest > time) {
      process.nextTick(function() {
        var newOptions = _.clone(options);
        newOptions.max_id = logs.min_id;
        searchLogs(token, query, newOptions, fillLogs);
      });
    } else {
      callback(null, allLogs);
    }
  }

  searchLogs(token, query, options, fillLogs);
}

dawg.get('/logs/apps', function(req, res) {
  var since = new Date().getTime() - (req.param('hours') * HOUR_IN_MS);
  searchLogsSince(since, lconfig.papertrailToken, req.param('query'), {
    group: lconfig.papertrailGroup
  }, function(err, logs) {
    var messages = _.pluck(logs, 'message');
    var linesByToken = _.groupBy(messages, function(msg) {
      return querystring.decode(msg).access_token;
    });
    var tokens = _.chain(Object.keys(linesByToken))
      .compact()
      .uniq()
      .value();
    getAppInfoFromUserAccessTokens(tokens, function(err, allInfo) {
      allInfo.forEach(function(info) {
        info.lines = [];
        info.tokens.forEach(function(token) {
          var cleanLines = _.map(linesByToken[token], function(line) {
            return line.replace(/access_token=[^&]+/, 'access_token=###');
          });
          info.lines = info.lines.concat(cleanLines);
        });
        info.lineCount = info.lines.length;
      });
      res.json(allInfo);
    });
  });
});
