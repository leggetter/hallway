var async = require('async');
var logger = require('logger').logger('friends');
var idr = require('idr');
var lutil = require('lutil');
var dMap = require('dMap');
var mmh = require("murmurhash3");
var ijod = require('ijod');
var taskman = require('taskman');
var dal = require('dal');
var qix = require('qix');

// change this to force re-indexing of any contact info on next run, whenever
// the indexing logic here changes
var VERSION = 6;

var DEFAULT_AVATARS = [
  /images.instagram.com\/profiles\/anonymousUser.jpg/, // Instagram
  /static-ak\/rsrc.php\/v2\/yL\/r\/HsTZSDw4avx.gif/,   // FB Male
  /static-ak\/rsrc.php\/v2\/yp\/r\/yDnr5YfbJCH.gif/,   // FB Female
  /4sqi\.net\/img\/blank_(boy|girl)/,                  // Foursquare
  /foursquare\.com\/img\/blank_/,                      // Foursquare also
  /twimg.com\/sticky\/default_profile_images/          // Twitter
];

// when merging profile info, which fields win out
var BESTY_FIELDS = {
  "facebook":["thumbnail_url", "name"],
  "twitter":["url", "description"]
};

// parallels are 32bit integers that align contact info - inner parallels are
// ones that dedup contacts into one, name, email, etc - outer parallels are
// ones that group contacts together, interactions, interests, relationships,
// etc

// return an array of the INNER parallels used for deduping, 4 32bit integers
// (hexified) first name, last name, email, handle || phone# TODO someday, if
// multiple emails/phones and there's room in the 4, include them
exports.parallels = function(entry) {
  var ret = [];
  var oe = dMap.get('oembed', entry.data, entry.idr);
  if (!oe || oe.type !== 'contact') return ret;

  // extract first/last
  if (oe.title) {
    // first byte is 3-char sort, other three bytes is full hash
    var name = exports.name(oe.title);
    ret.push(parts2par([
              dMap.partype('first'),
              str2sort(name.first),
              str2num(name.first, 2)
            ]));
    ret.push(parts2par([
              dMap.partype('last'),
              str2sort(name.last),
              str2num(name.last, 2)
            ]));
  }

  // any email address
  if (oe.email) {
    ret.push(parts2par([dMap.partype('email'), str2num(oe.email, 3)]));
  }

  // any phone#
  if (oe.phone) {
    // TODO normalize phone better!
    var phone = phoneHome(oe.phone);
    ret.push(parts2par([dMap.partype('phone'), str2num(phone, 3)]));
  } else if (oe.handle) { // alternatively, any handle
    // TODO, maybe if no handle but there is email and the email is @gmail
    // @yahoo etc, use the username part?
    ret.push(parts2par([dMap.partype('handle'), str2num(oe.handle, 3)]));
  }

  return ret;
};

// simple utils
exports.name = function(name) {
  var parts = (name) ? name.toLowerCase().split(/\s+/) : [];
  return {first:(parts.shift() || ''), last:(parts.pop() || '')};
};

function phoneHome(phone) {
  phone = phone.replace(/[^0-9]+/g, '');
  if (phone.length === 10) phone = "1" + phone;
  return phone;
}

// brute force, but we need a way to force contacts to be re-indexed (skip hash
// check) when the logic is changed
exports.vpump = function(cset, cbDone) {
  var ndx = {};
  dMap.types('contacts').forEach(function(key) { ndx[key] = "contact"; });
  cset.forEach(function(entry) {
    var types = dMap.typeOf(entry.idr);
    if (types.indexOf('contacts') >= 0) entry._v = VERSION;
  });
  cbDone(null, cset);
};

// process them post-ijod so that only new/updated contacts are efficiently
// indexed
exports.bump = function(cset, auth, cbDone) {
  if (!auth || !auth.apps) return cbDone(null, cset); // sanity check
  var pids = {};
  var iact = {inter:{}, act:{}, photos:{}, ll:{}};
  // first just build an index by pid to work with versus flat array
  var deviceId = false;
  var self = false;
  cset.forEach(function(entry) {
    if (!entry.saved) return; // only process *new* content!

    // we process our self entry specially to index global ids across the whole app
    var id = idr.parse(entry.idr);
    if (id.path === 'self') self = entry;

    // process based on the type
    var types = dMap.typeOf(entry.idr, entry.types);
    if (types.length === 0) return;
    if (types.indexOf('contacts') >= 0 || id.path === 'self') {
      // below we do a lot more work on contacts, including self
      id = idr.parse(entry.idr);
      // a device contact id is in the format devicename.accountid.appid@devices
      if (id.host === 'devices') deviceId = id.auth.split('.');
      var dest = encodeURIComponent(id.hash)+'@'+id.host;
      pids[dest] = entry;
      // TODO: for normal non-device contacts we should be looking for matching
      // phone/email's too, as they may not be friends on the same network but
      // across networks and still the same person
    }

    var participants = ijod.participants(entry);
    if (participants.length > 0) {
      var me = idr.parse(entry.idr).auth;
      // index of everyone we have interactions with
      if (participants.length > 1 && participants.indexOf(me) >= 0) {
        participants.forEach(function(p) {
          if (!iact.inter[p]) iact.inter[p] = 0;
          iact.inter[p]++;
        });
      }

      // keep track of sharing activity of others
      if (participants[0] !== me) {
        var author = participants[0];
        if (!iact.act[author]) iact.act[author] = 0;
        iact.act[author]++;
        // additionally track photos as a sub-sortable option
        if (types.indexOf('photos_feed') >= 0) {
          if (!iact.photos[author]) iact.photos[author] = 0;
          iact.photos[author]++;
        }
        // track last seen location
        var ll = dMap.get('ll', entry.data, entry.idr);
        if (ll && entry.at > (iact.ll[author] || 0)) iact.ll[author] = ll;
      }
    }
  });

  logger.debug("bump",
    Object.keys(pids).length,
    Object.keys(iact).map(function(key) {
      return {
        key:key,
        len:Object.keys(iact[key]).length
      };
    }));

  // this could be parallel, but that could be a lot of mysql too since they
  // internally parallelize
  async.series([
    function(cb) {
      indexMe(auth, self, cb);
    },
    function(cb) {
      friendex(auth, pids, cb);
    },
    function(cb) { // device contacts are special, per-app
      if (deviceId) devicePeers(deviceId[1], deviceId[2], pids, cb);
      else peerCheck(auth, pids, cb);
    },
    function(cb) {
      interactive(auth, iact, cb);
    }
  ], function() {
    cbDone(null, cset);
  });
};

// all ids extracted from this device contact
function allIds(data) {
  var ids = {};
  if (data.phone) ids[phoneHome(data.phone)] = true;
  if (data.email) ids[data.email.toLowerCase()] = true;
  if (Array.isArray(data.phones)) {
    data.phones.forEach(function(phone) {
      ids[phoneHome(phone)] = true;
    });
  }
  if (Array.isArray(data.emails)) {
    data.emails.forEach(function(email) {
      ids[email.toLowerCase()] = true;
    });
  }
  return ids;
}

// we need to index our own unique identifiers in an easily matchable way to
// find peers in an app
function indexMe(auth, entry, cbDone) {
  if (!entry) return cbDone();

  logger.debug("indexing me",entry.idr);
  var id = idr.parse(entry.idr);
  var isDevice = (id.host === 'devices' && id.protocol === 'contact');

  // first get all the unique ids, the device information is more rich than
  // oembed (plurals), use that if so
  var ids = allIds(isDevice ? entry.data : dMap.get('oembed', entry.data, entry.idr) || {});

  // get a list of apps from either auth or device
  var apps = auth && auth.apps;
  if (isDevice) { // have to spoof the auth.apps.accounts[] pattern
    apps = {};
    var parts = idr.parse(entry.idr).auth.split('.');
    apps[parts[2]] = {accounts:{}};
    apps[parts[2]].accounts[parts[1]] = true;
  }
  // now for each one save this account to it's app-wide entry
  var entries = [];
  Object.keys(apps).forEach(function(app) {
    if(typeof(apps[app].accounts) !== 'object') return;
    Object.keys(apps[app].accounts).forEach(function(account) {
      var base = 'index:'+app+'/account';
      logger.debug("deviceMe",base,ids);
      Object.keys(ids).forEach(function(id) {
        var index = {};
        index.idr = base + '#' + encodeURIComponent(id);
        index.account = account;
        index.data = {};
        index.via = idr.toString(entry.idr);
        entries.push(index);
      });
    });
  });
  ijod.batchSmartAdd(entries, cbDone);
}

// are any of these compadres using the app too?
function devicePeers(account, app, pids, cbDone) {
  if (Object.keys(pids).length === 0) return cbDone();

  var base = 'index:'+app+'/account';
  async.forEachLimit(Object.keys(pids), 5, function(pid, cbPids) {
    var ids = allIds(pids[pid].data);
    if (Object.keys(ids).length === 0) return process.nextTick(cbPids);
    async.forEach(Object.keys(ids), function(id, cbIds) {
      ijod.getOne(base+'#'+encodeURIComponent(id), function(err, entry) {
        if (!entry || !entry.account) return cbIds();
        // set up peering from this account to the other, pid is a localized
        // id@devices
        friendPeer(app, account, entry.account, pid, function(isNew) {
          // importantly, make sure reverse is set too!
          // use their localized device id for me
          var viaPid = encodeURIComponent(idr.parse(entry.via).hash) + '@devices';
          friendPeer(app, entry.account, account, viaPid, function() {
            // if (isNew) TODO, send notification to app if any
            pids[pid].peer = entry.account; // convenience for immediate action
            cbIds();
          });
        });
      });
    }, cbPids);
  }, cbDone);
}

// update pars for individuals who're doing stuff
function interactive(auth, iact, cbDone) {
  // to be efficient we need to get all actual friends, so build that list
  var service = auth.pid.split('@')[1];
  var bases = dMap.types('contacts', [auth.pid]);
  var options = {};

  // fetch all friends for this base, that are also in this list
  async.forEach(bases, function(base, cbBase) {
    var all = {};
    function build(obj) {
      Object.keys(obj).forEach(function(uid) {
        var id = base + '#' + encodeURIComponent(uid);
        all[idr.hash(id).toUpperCase()] = idr.parse(id);
      });
    }
    Object.keys(iact).forEach(function(key) {
      build(iact[key]);
    });
    options['in'] = Object.keys(all);

    if (options['in'].length === 0) {
      return process.nextTick(cbBase);
    }

    ijod.getPars(base, options, function(err, pars) {
      if (err) logger.warn("pars error",base,err);
      if (!pars) return cbBase();

      async.forEachLimit(Object.keys(pars), 10, function(idh, cbPars) {
        if (pars[idh].pars.length === 0) {
          return process.nextTick(cbPars); // skip non-indexed entries
        }
        
        if(!all[idh])
        {
          logger.warn("mysterious interactive things, no match:",idh,base,pars[idh]);
          return process.nextTick(cbPars);
        }

        // get any existing values to increment
        var id = all[idh];
        var options = {pars:[]};
        options.pars.push(parInc(parSelect(pars[idh].pars, 'interactions'), iact.inter[id.hash]));
        options.pars.push(parInc(parSelect(pars[idh].pars, 'activity'), iact.act[id.hash]));
        options.pars.push(parInc(parSelect(pars[idh].pars, 'photos'), iact.photos[id.hash]));
        // TODO geo latlng
        logger.debug("updating interactives for",id.hash,options);
        ijod.setOneCat(idr.toString(id), "outer", options, function() {
          cbPars();
        });
      }, function() {
        cbBase();
      });
    });
  }, cbDone);
}

// now, see if there is a peering relationship
function peerCheck(auth, pids, cbDone) {
  if (!auth.apps || Object.keys(pids).length === 0) return cbDone();
  // this has to be done app by app
  async.forEach(Object.keys(auth.apps), function(app, cbApp) {
    // dumb safety check
    if (!auth.apps[app].accounts) {
      return process.nextTick(cbApp);
    }
    var ids = Object.keys(pids).map(function(id) {
      return "'" + id + "'";
    }).join(",");
    var sql = "SELECT account, profile from Accounts where app = ? and profile in ("+ ids +")";
    // bulk query efficiently
    logger.debug("bulk querying",sql);
    dal.query(sql, [app], function(err, rows) {
      if (!rows || rows.length === 0) return cbApp();
      var pairs = genPairs(Object.keys(auth.apps[app].accounts), rows);
      logger.debug("found pairs",auth.pid,app,pairs);
      async.forEachLimit(pairs, 10, function(pair, cbPair) {
        // set up peering from this account to the other
        friendPeer(app, pair.src, pair.dest, pair.pid, function(isNew) {
          // importantly, make sure reverse is set too!
          friendPeer(app, pair.dest, pair.src, auth.pid, function() {
            // if (isNew) TODO, send notification to app if any
            cbPair();
          });
        });
      }, cbApp);
    });
  }, cbDone);
}

// convenient since it has to be done twice, update status to a peer
function friendPeer(app, src, dest, pid, cbDone) {
  // for every found pairing, get any already indexed id parallels and add this
  // to the set
  // construct the per-app-account idr where the statuses are saved
  var id = 'friend:'+src+'@'+app+'/friends#'+dest;
  ijod.getOnePars(id, "ids", function(err, one) {
    var pars = one && one.pars;
    if (parStatus(pars, "peers")) return cbDone(false);
    // new peering!
    logger.debug("new peering found ",app,src,dest,pid);
    pars = parUpdateStatus(pars, "peers", true);
    var par = pid2par(pid);
    // also be sure to index the pid for it to match
    if (pars.indexOf(par) === -1) pars.unshift(par);
    ijod.setOneCat(id, "ids", {pars:pars}, function() {
      cbDone(true);
    });
  });

}

// index additional attributes on friends
function friendex(auth, friends, cbDone) {
  logger.debug("friendex",auth.pid,Object.keys(friends).length);
  async.forEachLimit(Object.keys(friends), 10, function(pid, cbFriends) {
    var friend = friends[pid];
    var oe = dMap.get('oembed', friend.data, friend.idr) || {};
    async.waterfall([
      function(cb) { // handle indexing the related ids
        var options = {pars:[]};
        options.pars.push(pid2par(pid));
        if (oe.url) options.pars.push(parts2par([dMap.partype("url"), str2num(oe.url)]));
        if (oe.website) options.pars.push(parts2par([dMap.partype("url"), str2num(oe.website)]));
        // TODO add a par for relation, matching school/employer to auth.profile
        // index bio text
        var buf = qix.buf(bioget(friend, oe));
        if (buf) {
          options.q = [];
          options.q.push(buf.slice(0,8).toString('hex'));
          options.q.push(buf.slice(8,16).toString('hex'));
          options.q.push(buf.slice(16,24).toString('hex'));
          options.q.push(buf.slice(24).toString('hex'));
        }
        ijod.setOneCat(idr.toString(friend.idr), "ids", options, cb);
      },
      function(cb) {
        // TODO interest par (keywords from bio, interests on facebook, device types)
        // driven by apps?
        cb();
      }
    ], function() {
      cbFriends();
    });
  }, cbDone);
}

// get bio text
function bioget(friend, oe) {
  if (!oe) oe = dMap.get('oembed', friend.data, friend.idr) || {};
  var ret = [oe.description];
  var entities = dMap.get('entities', friend.data, friend.idr) || [];
  entities.forEach(function(entity) { ret.push(entity.name); });
  return ret.join(' ');
}

// id@service to it's par representation
function pid2par(pid) {
  var parts = pid.split('@');
  return parts2par([parts[1], str2num(parts[0], 3)]);
}

var STATUSES = {"peers":0, "invited":1, "requested":2, "blocked":3};
// return an object of the statuses set in this list of pars
exports.status = function(pars) {
  var ret = {};
  pars.forEach(function(par) {
    if (ptype(par) !== 'status') return;
    var bits = parseInt(par, 16).toString(2).split('');
    Object.keys(STATUSES).forEach(function(status) {
      if (bits[8+STATUSES[status]] === '1') ret[status] = true;
    });
  });
  return ret;
};

// update any status parallel to include the new one
function parUpdateStatus(pars, status, value) {
  var spar = parts2par(['status', 0]); // default blank
  var ret = [];
  if (!pars) pars = [];
  pars.forEach(function(par) {
    // extract any existing one
    if (ptype(par) === 'status') spar = par;
    else ret.push(par);
  });
  // binary flip the bit
  var bits = parseInt(spar, 16).toString(2).split('');
  bits[8+STATUSES[status]] = (value) ? "1" : "0";
  spar = hexen(parseInt(bits.join(''),2),8);
  ret.unshift(spar);
  return ret;
}
// just check current status
function parStatus(pars, status) {
  var ret = false;
  if (!pars) return false;
  pars.forEach(function(par) {
    if (ptype(par) !== 'status') return;
    var bits = parseInt(par, 16).toString(2).split('');
    if (bits[8+STATUSES[status]] === '1') ret = true;
  });
  return false;
}

// ugly, two dynamic lists
function genPairs(accounts, rows) {
  logger.debug("find pairs between",accounts,rows);
  var pairs = {};
  rows.forEach(function(row) {
    accounts.forEach(function(account) {
      // there could super edge case be multiple ways they're pair'd, this
      // forces just one for sanity
      pairs[[account,row.account].join('\t')] = row.profile;
    });
  });
  var ret = [];
  Object.keys(pairs).forEach(function(key) {
    var parts = key.split('\t');
    if (parts[0] === parts[1]) return; // skip self duh
    ret.push({src:parts[0], dest:parts[1], pid:pairs[key]});
  });
  return ret;
}

// fetch all the bases and return a merged set
exports.baseMerge = function(bases, options, callback) {
  var ndx = {};
  var ids = {};
  async.forEach(bases, function(base, cbBase) {
    // when this base is the ace (status) one, it can't freshen or get options
    // applied
    taskman.fresh((options.fresh && (base !== options.ace) && base), function(err) {
      if (err) logger.warn("fresh error",base,err);
      ijod.getPars(base, (options.ace === base) ? {xids:true} : options, function(err, pars) {
        if (err) logger.warn("pars error",base,err);
        if (!pars) return cbBase();
        // loop through and build sorta an inverse index for merging checks
        Object.keys(pars).forEach(function(id) {
          if (pars[id].pars.length === 0) return; // skip non-indexed entries
          ids[id] = pars[id];
          ids[id].id = id.toLowerCase() + '_' + idr.partition(base);
          ids[id].mergies = [];
          ids[id].base = base;
          ids[id].pars.forEach(function(par) {
            // stash the data a few ways using the name of the type for sanity's
            // sake
            var type = ptype(par);
            ids[id][type] = par;
            if (type === "email" || type === "phone" || type === "handle" || type === "url") {
              ids[id].mergies.push(par); // all direct mergable fields
            }
            // all service ids
            if (parseInt(par.substr(0,2), 16) >= 100) ids[id].mergies.push(par);
            if (!ndx[type]) ndx[type] = {};
            if (!ndx[type][par]) ndx[type][par] = [];
            ndx[type][par].push(id);
          });
        });
        cbBase();
      });
    });
  }, function() {
    // util to increment during merge
    function inc(friend, id, field) {
      if (!ids[id][field]) return;
      if (!friend[field]) friend[field] = 0;
      friend[field] += parseInt(ids[id][field].substr(2),16);
    }
    // util to merge
    function merge(friend, id) {
      if (ids[id].merged) return; // already merged
      if (friend.ids[id]) return; // edge case catch, since we recurse!
      friend.ids[id] = true;
      friend.connected++;
      friend.profiles.push(ids[id]);
      if (ids[id].q) friend.matched = true;
      if (ids[id].bio) friend.bio = true;
      // for sorting
      if (!friend.first && ids[id].first) friend.first = ids[id].first;
      if (!friend.last && ids[id].last) friend.last = ids[id].last;
      if (ids[id].xid) friend.peer = ids[id].xid; // cross-ref id
      inc(friend,id,"interactions");
      inc(friend,id,"activity");
      inc(friend,id,"photos");
      seek(id, friend); // now also recurse in and see if the merged id had other matchable bits
      ids[id].merged = friend;
    }
    var friends = [];
    // check if this id is mergeable w/ any others, add to friend
    function seek(id, friend) {
      if (ids[id].merged) return; // id already merged
      // merge the mergies! (exact id matches)
      ids[id].mergies.forEach(function(par) {
        ndx[ptype(par)][par].forEach(function(dup) {
          merge(friend,dup);
        });
      });
      // only merge when first and last match exactly
      if (ids[id].first) ndx.first[ids[id].first].forEach(function(dup) {
        if (ids[id].last === ids[dup].last) merge(friend,dup);
      });
    }
    // do the merging
    Object.keys(ids).forEach(function(id) {
      var friend = {profiles:[], ids:{}, connected:0};
      seek(id, friend); // look for duplicates
      merge(friend, id); // always add self
      friends.push(friend);
    });
    if (options.q) friends = friends.filter(function(friend) {
      return friend.matched;
    });
    if (options.bio) friends = friends.filter(function(friend) {
      return friend.bio;
    });
    callback(null, friends);
  });
};

function checkPlease(search, body, sensitive) {
  var b = qix.chunk(body, sensitive);
  var s = qix.chunk(search, sensitive);
  var matches = 0;
  b.forEach(function(bpart) {
    s.forEach(function(spart) {
      if (bpart.indexOf(spart) >= 0) matches++;
    });
  });
  if (matches < s.length) {
    logger.warn("couldn't find match ",s.join(','),"in",b.join(','));
    return false;
  }
  return true;
}
// make sure this friend matches the query
exports.validate = function(friend, options) {
  if (options.q && !checkPlease(options.q, ijod.qtext(friend), true)) return false;
  if (options.bio && !checkPlease(options.bio, bioget(friend), false)) return false;
  return true;
};

// utility to map all sorting options to actionables
exports.sorts = function(sort, a, b) {
  if (!a || a === '') a = undefined;
  if (!b || b === '') b = undefined;
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  if (sort === 'first' || sort === 'last') {
    return (a < b) ? -1 : ((a > b) ? 1 : 0);
  }
  if (['connected', 'interactions', 'activity', 'photos'].indexOf(sort) >= 0) {
    return b - a; // descending
  }
  return a - b;
};

// gen a toc for the list, sort = first||last||connected
exports.ginTonic = function(list, sort) {
  var toc = {"meta":{"length":list.length, "sort":sort}};

  if (sort === 'connected') { // totally different style
    var current = list[0].connected;
    var start = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i].connected === current) continue;
      toc[current.toString()] = {"offset":start, "length":(i - start)};
      current = list[i].connected;
      start = i;
    }
    toc[current.toString()] = {"offset":start, "length":((list.length-1)-start)};
    return toc;
  }

  // first || last
  var map = tocmap(sort);
  var on = map.shift();
  on.start = 0;
  function check(offset) {
    if (!on.c || (map[0] && parseInt(list[offset][sort],16) < map[0].v)) return;
    toc[on.c] = {"offset":on.start, "length":(offset-on.start)};
    on = map.shift() || {};
    on.start = offset;
    return check(offset);
  }
  for (var j = 0; j < list.length; j++) check(j);
  toc["*"] = {"offset":on.start, "length":(list.length-1)-on.start};
  return toc;
};

// combine multiple oembeds into one
exports.profile = function(profile, entry, options) {
  options = options || {};
  if (!profile) profile = {services:{}};
  if (!entry) return profile;
  // TODO remove once all email's are map'd into oembed.email
  if (entry.data && entry.data.email) profile.email = entry.data.email;

  var oembed = dMap.get('oembed', entry.data, entry.idr);
  if (!oembed) return profile;
  // convenient to have and keep consistent
  if (!oembed.id) oembed.id = idr.parse(entry.idr).hash;
  oembed.entry = entry.id;

  var service = oembed.provider_name;
  profile.services[service] = oembed;

  // unoembedize
  oembed.name = oembed.title;
  delete oembed.type;
  delete oembed.provider_name;
  delete oembed.title;

  // remove any default thumbnails
  if (oembed.thumbnail_url) DEFAULT_AVATARS.forEach(function(avatar) {
    if (oembed.thumbnail_url && oembed.thumbnail_url.match(avatar)) delete oembed.thumbnail_url;
  });

  Object.keys(oembed).forEach(function(key) {
    // don't copy up some service-specific fields
    if (key === 'id' || key === 'entry') return;
    if (!profile[key] || (BESTY_FIELDS[service] && BESTY_FIELDS[service].indexOf(key) !== -1)) {
      profile[key] = oembed[key]; // copy up unique values
    }
    // don't keep dups around
    if (options.light && profile[key] === oembed[key]) delete oembed[key];
  });

  if (options.full)
  {
    if (!profile.full) profile.full = {};
    profile.full[service] = entry;
  }

  return profile;
};

// parallels are groupd into categories, since they're stored 4-per-row (for
// now, bit of a hack to fit current entries data model)
var CATS = {"inner":0, "ids":1, "outer":2, "interests":3};
exports.parCats = function() {
  return CATS;
};

// convert an id into it's cat ver, just shift the last nib by the cat value
exports.parCat = function(id, cat) {
  id = id.toLowerCase();
  if (!CATS[cat]) return id;
  var x = parseInt(id.substr(-1,1),16) + CATS[cat];
  return id.substr(0,31) + (x.toString(16)).substr(-1,1);
};

// just get one par or return blank
function parSelect(pars, type) {
  var ret = parts2par([type, 0]); // default blank
  if (!pars) pars = [];
  pars.forEach(function(par) {
    if (ptype(par) === 'status') ret = par;
  });
  return ret;
}

// increment a par
function parInc(par, val) {
  if (!val) return par;
  var cur = parseInt(par.substr(2), 16);
  cur += val;
  return par.substr(0,2) + hexen(cur, 6);
}

// convenience, string par to string type
function ptype(par) {
  return dMap.partype(parseInt(par.substr(0,2), 16));
}

// just a simple hash into a number
function str2num(str, bytes) {
  bytes = bytes || 4;
  return (parseInt(mmh.murmur32HexSync(str.toLowerCase()),16) % Math.pow(256,bytes));
}

// convert string into an alphanumeric sortable byte, max 3 chars
function str2sort(str) {
  str = (str.toLowerCase()+'...').substr(0,3); // max first three, all required
  // the magic number is just short of base 27^3
  return Math.floor((parseInt(str.split('').map(str26).join(''),27) / 19682) * 255);
}

// this could be static, just makes an array mapping char to the hex part for
// sorting
function tocmap(sort) {
  return 'abcdefghijklmnopqrstuvwxyz'.split('').map(function(c) {
    return {
      c: c,
      v: parseInt(parts2par([sort,str2sort(c+'aa'),0]),16)
    };
  });
}

// convert any character to it's 0-26 alpha only range
function str26(str) {
  var code = str.charCodeAt(0);
  // alpha preserved only, else below z
  return ((code && code > 96 && code < 123) ? code - 97 : 26).toString(27);
}

// combine bytes into, either [type, 24bit int] or [type, 8bit int, 16bit in]
function parts2par(parts) {
  if (typeof parts[0] === 'string') parts[0] = dMap.partype(parts[0]);
  var ret = hexen(parts.shift(), 2);
  if (parts.length === 1) return ret + hexen(parts.shift(), 6);
  ret += hexen(parts.shift(), 2);
  if (parts.length === 1) return ret + hexen(parts.shift(), 4);
  return ret + hexen(parts.shift(), 2) + hexen(parts.shift(), 2);
}

// zero-pad hex number conversion
function hexen(num, len) {
  var base = '00000000';
  base += num.toString(16);
  return base.substr(-len,len);
}
