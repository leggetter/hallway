var async = require('async');
var urllib = require('url');
var request = require('request');
var querystring = require('querystring');
var idr = require('idr');
var dMap = require('dMap');
var logger = require('logger').logger("resolve");

var timeout = 5000;

// scan refs to see if we did links already, idempotent assuming we're the only ones making http's
function refcheck(refs)
{
  if(!refs) return false;
  var refa = Object.keys(refs);
  for(var i = 0; i < refa.length; i++) if(refa[i].indexOf('http') == 0) return true;
  return false;
}

// be as smart as possible to bulk process all urls in a changeset, often they have some affinity
exports.pump = function(cset, callback) {
  // save out each url as a ref to any entries
  var did = {};
  function saver(task, resolved)
  {
    if(resolved) {
      var url2 = urllib.format(urllib.parse(resolved));
      if(url2.indexOf('http') == 0) did[task.url] = resolved;      
    }
//    logger.debug("resolved",task.url,did[task.url]);
    task.entries.forEach(function(entry){
      if(!entry.refs) entry.refs = {};
      entry.refs[did[task.url] || task.url] = task.url;
    });
  }
  // worker queue to expand individual urls for an entry
  var doing = {};
  var q = async.queue(function(task, cb){
    // max timer
    task.timer = setTimeout(function(){
      logger.debug("timing out",task.url);
      task.timer = false;
      saver(task, task.url); // save that it broke
      cb();
    }, timeout*2);
    expand({url:task.url}, function(arg){
      if(task.timer === false) return; // timed out already!
      clearTimeout(task.timer);
      if(arg.err) logger.debug("link resolving warning",arg.url,arg.err);
      if(typeof arg.url != 'string') arg.url = task.url; // use original if expansion failed
      saver(task, arg.url);
      process.nextTick(cb);
    });
  }, 10);
  q.drain = function(){ callback(null, cset) };
  // only queue up each url if any
  var pushed = false;
  cset.forEach(function(entry){
    var urls = dMap.get('urls', entry.data, entry.idr);
    if(!Array.isArray(urls)) return;
    if(refcheck(entry.refs)) return; // idempotent
    urls.forEach(function(url){
      if(typeof url != "string") return;
      // normalize and sanity
      url = urllib.format(urllib.parse(url));
      if(url.indexOf('http') != 0) return;
      // blacklist this thing, comes from broken/trimmed tweets
      if(url == 'http://t.co/') return;
      // skip ones already in this changeset, helps a lot
      if(did[url]) return saver({entries:[entry], url:url});
      // already in the queue, append
      if(doing[url]) return doing[url].entries.push(entry);
      // create a new task
      doing[url] = {entries:[entry], url:url};
      pushed = true;
      q.push(doing[url]);
    });
  });
  if(!pushed) q.drain(); // this is a stupid pattern with queues, there should be a better way
}


// inspired by unshortener.js

var map = {
    isgd: ['is.gd'],
    googl: ['goo.gl'],
    budurl: ['budurl.com'],
    snipurl: ['snipurl.com', 'snurl.com', 'snurl.com', 'cl.lk', 'snipr.com', 'sn.im']
};

var timeout = 5000;

function expand(args, callback) {
    if(!args || !args.url || typeof(args.url) != 'string') return callback(args);

    // set up defaults
    if(!args.depth) args.depth = 0;
    if(!args.seen) args.seen = {};

    // if we've recursed too far, bail
    if(args.depth > 5) return callback(args);

    // if we've seen this url already, loop bail!
    if(args.seen[args.url]) return callback(args);
    args.seen[args.url] = true;

    // does it parse?
    args.urlp = urllib.parse(args.url);
    if(!args.urlp) return callback(args);

    // only process http stuff, are there any https shorteners?
    if(args.urlp.protocol != 'http:') return callback(args);

    // ok, now process a url!
    args.depth++;

    // do we have a custom api call for it?
    for (var k in map) {
        if (map[k].indexOf(args.urlp.host) > -1) return APIs[k](args, callback);
    }

    // only for known shortener domains, fall back to generic HEAD request
    if(SHORTs[args.urlp.host]) return APIs.generic(args, callback);
    
    // everything else pass through
    return callback(args);
}


var APIs = {

    // all of these try to recurse on any result, or any error fall back to generic HEAD request

    isgd: function (args, callback) {
        var url = 'http://is.gd/forward.php?' + querystring.stringify({format: 'json', shorturl: args.urlp.pathname.replace('/', '')});
        request.get({url:url, timeout:timeout, json:true}, function(err, res, body){
            if(body && body.url) {
                args.url = body.url;
                return expand(args, callback);
            }
            return APIs.generic(args, callback);
        });
    },

    googl: function (args, callback) {
        var url = 'https://www.googleapis.com/urlshortener/v1/url?'+querystring.stringify({shortUrl: args.urlp.href});
        request.get({url:url, timeout:timeout, json:true}, function(err, res, body){
            if(body && body.longUrl) {
                args.url = body.longUrl;
                return expand(args, callback);
            }
            return APIs.generic(args, callback);
        });
    },

    budurl: function (args, callback) {
        var url = 'http://budurl.com/api/v1/budurls/expand?'+querystring.stringify({budurl: args.urlp.pathname.replace('/', '')});
        request.get({url:url, timeout:timeout, json:true}, function(err, res, body){
            if(body && body.long_url) {
                args.url = body.long_url;
                return expand(args, callback);
            }
            return APIs.generic(args, callback);
        });
    },

    snipurl: function (args, callback) {
        var url = 'http://snipurl.com/resolveurl?'+querystring.stringify({id: args.urlp.pathname.replace('/', '')});
        request.get({url:url, timeout:timeout}, function(err, res, body){
            if(body) {
                args.url = body;
                return expand(args, callback);
            }
            return APIs.generic(args, callback);
        });
    },

    generic: function (args, callback) {
        var headers = (args.urlp.host === "t.co")?{}:{'User-Agent': 'AppleWebKit/525.13 (KHTML, like Gecko) Safari/525.13.'}; // t.co returns meta refresh if browser!
        if(args.same && args.headers && args.headers['set-cookie']) headers['Cookie'] = args.headers['set-cookie']; // really dumb hack to enable cookie-tracking redirectors
        headers['Connection'] = 'close'; // workaround to fix Parser Error's after the request, see https://github.com/joyent/node/issues/2997
        var req = request.head({url:args.url, headers:headers, followRedirect:false, timeout:timeout, agent:false}, function(err, res){
            if(err) { args.err = err; return callback(args); }
            // process a redirect
            if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307)
            {
                // re-basing like a browser would, yes sam, this happens
                if(!res.headers.location) { args.err = 'missing location header on a 3xx'; return callback(args); }
                var newup = urllib.parse(urllib.resolve(args.urlp,urllib.parse(res.headers.location)));
                // if the url is unparseable, bail out
                if (!newup || !newup.pathname) return callback(args);
                // if we're redirected to a login page, bail, kinda lame heuristic here but it works pretty well!
                if(newup.pathname.indexOf("login") > 0 && newup.pathname.indexOf("login") < 10) return callback(args);
                args.same = (args.url.indexOf(newup.host) > 0) ? true : false;
                args.url = urllib.format(newup);
                args.headers = res.headers; // convenience for callback
                return expand(args, callback);
            }
            args.headers = res.headers; // convenience for callback
            // everything else, we're done done!
            return callback(args);
        });
        /* this is double-erroring due to or related to https://github.com/joyent/node/issues/2997
        req.on('error',function(err){
          logger.error("request error",err);
          args.err = err;
          callback(args);
        });*/
    }
};

// this was generated from http://api.longurl.org/v2/services?format=json on 7/31/12 and should be updated if you are reading this over a month past!
var SHORTs = {
  "0rz.tw": {
    "domain": "0rz.tw",
    "regex": ""
  },
  "1link.in": {
    "domain": "1link.in",
    "regex": ""
  },
  "1url.com": {
    "domain": "1url.com",
    "regex": ""
  },
  "2.gp": {
    "domain": "2.gp",
    "regex": ""
  },
  "2big.at": {
    "domain": "2big.at",
    "regex": ""
  },
  "2tu.us": {
    "domain": "2tu.us",
    "regex": ""
  },
  "3.ly": {
    "domain": "3.ly",
    "regex": ""
  },
  "307.to": {
    "domain": "307.to",
    "regex": ""
  },
  "4ms.me": {
    "domain": "4ms.me",
    "regex": ""
  },
  "4sq.com": {
    "domain": "4sq.com",
    "regex": ""
  },
  "4url.cc": {
    "domain": "4url.cc",
    "regex": ""
  },
  "6url.com": {
    "domain": "6url.com",
    "regex": ""
  },
  "7.ly": {
    "domain": "7.ly",
    "regex": ""
  },
  "a.gg": {
    "domain": "a.gg",
    "regex": ""
  },
  "a.nf": {
    "domain": "a.nf",
    "regex": ""
  },
  "aa.cx": {
    "domain": "aa.cx",
    "regex": ""
  },
  "abcurl.net": {
    "domain": "abcurl.net",
    "regex": ""
  },
  "ad.vu": {
    "domain": "ad.vu",
    "regex": ""
  },
  "adf.ly": {
    "domain": "adf.ly",
    "regex": ""
  },
  "adjix.com": {
    "domain": "adjix.com",
    "regex": ""
  },
  "afx.cc": {
    "domain": "afx.cc",
    "regex": ""
  },
  "all.fuseurl.com": {
    "domain": "all.fuseurl.com",
    "regex": ""
  },
  "alturl.com": {
    "domain": "alturl.com",
    "regex": ""
  },
  "amzn.to": {
    "domain": "amzn.to",
    "regex": ""
  },
  "ar.gy": {
    "domain": "ar.gy",
    "regex": ""
  },
  "arst.ch": {
    "domain": "arst.ch",
    "regex": ""
  },
  "atu.ca": {
    "domain": "atu.ca",
    "regex": ""
  },
  "azc.cc": {
    "domain": "azc.cc",
    "regex": ""
  },
  "b23.ru": {
    "domain": "b23.ru",
    "regex": ""
  },
  "b2l.me": {
    "domain": "b2l.me",
    "regex": ""
  },
  "bacn.me": {
    "domain": "bacn.me",
    "regex": ""
  },
  "bcool.bz": {
    "domain": "bcool.bz",
    "regex": ""
  },
  "binged.it": {
    "domain": "binged.it",
    "regex": ""
  },
  "bit.ly": {
    "domain": "bit.ly",
    "regex": ""
  },
  "bizj.us": {
    "domain": "bizj.us",
    "regex": ""
  },
  "bloat.me": {
    "domain": "bloat.me",
    "regex": ""
  },
  "bravo.ly": {
    "domain": "bravo.ly",
    "regex": ""
  },
  "bsa.ly": {
    "domain": "bsa.ly",
    "regex": ""
  },
  "budurl.com": {
    "domain": "budurl.com",
    "regex": ""
  },
  "canurl.com": {
    "domain": "canurl.com",
    "regex": ""
  },
  "chilp.it": {
    "domain": "chilp.it",
    "regex": ""
  },
  "chzb.gr": {
    "domain": "chzb.gr",
    "regex": ""
  },
  "cl.lk": {
    "domain": "cl.lk",
    "regex": ""
  },
  "cl.ly": {
    "domain": "cl.ly",
    "regex": ""
  },
  "clck.ru": {
    "domain": "clck.ru",
    "regex": ""
  },
  "cli.gs": {
    "domain": "cli.gs",
    "regex": ""
  },
  "cliccami.info": {
    "domain": "cliccami.info",
    "regex": ""
  },
  "clickthru.ca": {
    "domain": "clickthru.ca",
    "regex": ""
  },
  "clop.in": {
    "domain": "clop.in",
    "regex": ""
  },
  "conta.cc": {
    "domain": "conta.cc",
    "regex": ""
  },
  "cort.as": {
    "domain": "cort.as",
    "regex": ""
  },
  "cot.ag": {
    "domain": "cot.ag",
    "regex": ""
  },
  "crks.me": {
    "domain": "crks.me",
    "regex": ""
  },
  "ctvr.us": {
    "domain": "ctvr.us",
    "regex": ""
  },
  "cutt.us": {
    "domain": "cutt.us",
    "regex": ""
  },
  "dai.ly": {
    "domain": "dai.ly",
    "regex": ""
  },
  "decenturl.com": {
    "domain": "decenturl.com",
    "regex": ""
  },
  "dfl8.me": {
    "domain": "dfl8.me",
    "regex": ""
  },
  "digbig.com": {
    "domain": "digbig.com",
    "regex": ""
  },
  "digg.com": {
    "domain": "digg.com",
    "regex": "http:\\\/\\\/digg\\.com\\\/[^\\\/]+$"
  },
  "disq.us": {
    "domain": "disq.us",
    "regex": ""
  },
  "dld.bz": {
    "domain": "dld.bz",
    "regex": ""
  },
  "dlvr.it": {
    "domain": "dlvr.it",
    "regex": ""
  },
  "do.my": {
    "domain": "do.my",
    "regex": ""
  },
  "doiop.com": {
    "domain": "doiop.com",
    "regex": ""
  },
  "dopen.us": {
    "domain": "dopen.us",
    "regex": ""
  },
  "easyuri.com": {
    "domain": "easyuri.com",
    "regex": ""
  },
  "easyurl.net": {
    "domain": "easyurl.net",
    "regex": ""
  },
  "eepurl.com": {
    "domain": "eepurl.com",
    "regex": ""
  },
  "eweri.com": {
    "domain": "eweri.com",
    "regex": ""
  },
  "fa.by": {
    "domain": "fa.by",
    "regex": ""
  },
  "fav.me": {
    "domain": "fav.me",
    "regex": ""
  },
  "fb.me": {
    "domain": "fb.me",
    "regex": ""
  },
  "fbshare.me": {
    "domain": "fbshare.me",
    "regex": ""
  },
  "ff.im": {
    "domain": "ff.im",
    "regex": ""
  },
  "fff.to": {
    "domain": "fff.to",
    "regex": ""
  },
  "fire.to": {
    "domain": "fire.to",
    "regex": ""
  },
  "firsturl.de": {
    "domain": "firsturl.de",
    "regex": ""
  },
  "firsturl.net": {
    "domain": "firsturl.net",
    "regex": ""
  },
  "flic.kr": {
    "domain": "flic.kr",
    "regex": ""
  },
  "flq.us": {
    "domain": "flq.us",
    "regex": ""
  },
  "fly2.ws": {
    "domain": "fly2.ws",
    "regex": ""
  },
  "fon.gs": {
    "domain": "fon.gs",
    "regex": ""
  },
  "freak.to": {
    "domain": "freak.to",
    "regex": ""
  },
  "fuseurl.com": {
    "domain": "fuseurl.com",
    "regex": ""
  },
  "fuzzy.to": {
    "domain": "fuzzy.to",
    "regex": ""
  },
  "fwd4.me": {
    "domain": "fwd4.me",
    "regex": ""
  },
  "fwib.net": {
    "domain": "fwib.net",
    "regex": ""
  },
  "g.ro.lt": {
    "domain": "g.ro.lt",
    "regex": ""
  },
  "gizmo.do": {
    "domain": "gizmo.do",
    "regex": ""
  },
  "gl.am": {
    "domain": "gl.am",
    "regex": ""
  },
  "go.9nl.com": {
    "domain": "go.9nl.com",
    "regex": ""
  },
  "go.ign.com": {
    "domain": "go.ign.com",
    "regex": ""
  },
  "go.usa.gov": {
    "domain": "go.usa.gov",
    "regex": ""
  },
  "goo.gl": {
    "domain": "goo.gl",
    "regex": ""
  },
  "goshrink.com": {
    "domain": "goshrink.com",
    "regex": ""
  },
  "gurl.es": {
    "domain": "gurl.es",
    "regex": ""
  },
  "hex.io": {
    "domain": "hex.io",
    "regex": ""
  },
  "hiderefer.com": {
    "domain": "hiderefer.com",
    "regex": ""
  },
  "hmm.ph": {
    "domain": "hmm.ph",
    "regex": ""
  },
  "href.in": {
    "domain": "href.in",
    "regex": ""
  },
  "hsblinks.com": {
    "domain": "hsblinks.com",
    "regex": ""
  },
  "htxt.it": {
    "domain": "htxt.it",
    "regex": ""
  },
  "huff.to": {
    "domain": "huff.to",
    "regex": ""
  },
  "hulu.com": {
    "domain": "hulu.com",
    "regex": ""
  },
  "hurl.me": {
    "domain": "hurl.me",
    "regex": ""
  },
  "hurl.ws": {
    "domain": "hurl.ws",
    "regex": ""
  },
  "icanhaz.com": {
    "domain": "icanhaz.com",
    "regex": ""
  },
  "idek.net": {
    "domain": "idek.net",
    "regex": ""
  },
  "ilix.in": {
    "domain": "ilix.in",
    "regex": ""
  },
  "is.gd": {
    "domain": "is.gd",
    "regex": ""
  },
  "its.my": {
    "domain": "its.my",
    "regex": ""
  },
  "ix.lt": {
    "domain": "ix.lt",
    "regex": ""
  },
  "j.mp": {
    "domain": "j.mp",
    "regex": ""
  },
  "jijr.com": {
    "domain": "jijr.com",
    "regex": ""
  },
  "kl.am": {
    "domain": "kl.am",
    "regex": ""
  },
  "klck.me": {
    "domain": "klck.me",
    "regex": ""
  },
  "korta.nu": {
    "domain": "korta.nu",
    "regex": ""
  },
  "krunchd.com": {
    "domain": "krunchd.com",
    "regex": ""
  },
  "l9k.net": {
    "domain": "l9k.net",
    "regex": ""
  },
  "lat.ms": {
    "domain": "lat.ms",
    "regex": ""
  },
  "liip.to": {
    "domain": "liip.to",
    "regex": ""
  },
  "liltext.com": {
    "domain": "liltext.com",
    "regex": ""
  },
  "linkbee.com": {
    "domain": "linkbee.com",
    "regex": ""
  },
  "linkbun.ch": {
    "domain": "linkbun.ch",
    "regex": ""
  },
  "liurl.cn": {
    "domain": "liurl.cn",
    "regex": ""
  },
  "ln-s.net": {
    "domain": "ln-s.net",
    "regex": ""
  },
  "ln-s.ru": {
    "domain": "ln-s.ru",
    "regex": ""
  },
  "lnk.gd": {
    "domain": "lnk.gd",
    "regex": ""
  },
  "lnk.ms": {
    "domain": "lnk.ms",
    "regex": ""
  },
  "lnkd.in": {
    "domain": "lnkd.in",
    "regex": ""
  },
  "lnkurl.com": {
    "domain": "lnkurl.com",
    "regex": ""
  },
  "lru.jp": {
    "domain": "lru.jp",
    "regex": ""
  },
  "lt.tl": {
    "domain": "lt.tl",
    "regex": ""
  },
  "lurl.no": {
    "domain": "lurl.no",
    "regex": ""
  },
  "macte.ch": {
    "domain": "macte.ch",
    "regex": ""
  },
  "mash.to": {
    "domain": "mash.to",
    "regex": ""
  },
  "merky.de": {
    "domain": "merky.de",
    "regex": ""
  },
  "migre.me": {
    "domain": "migre.me",
    "regex": ""
  },
  "miniurl.com": {
    "domain": "miniurl.com",
    "regex": ""
  },
  "minurl.fr": {
    "domain": "minurl.fr",
    "regex": ""
  },
  "mke.me": {
    "domain": "mke.me",
    "regex": ""
  },
  "moby.to": {
    "domain": "moby.to",
    "regex": ""
  },
  "moourl.com": {
    "domain": "moourl.com",
    "regex": ""
  },
  "mrte.ch": {
    "domain": "mrte.ch",
    "regex": ""
  },
  "myloc.me": {
    "domain": "myloc.me",
    "regex": ""
  },
  "myurl.in": {
    "domain": "myurl.in",
    "regex": ""
  },
  "n.pr": {
    "domain": "n.pr",
    "regex": ""
  },
  "nbc.co": {
    "domain": "nbc.co",
    "regex": ""
  },
  "nblo.gs": {
    "domain": "nblo.gs",
    "regex": ""
  },
  "nn.nf": {
    "domain": "nn.nf",
    "regex": ""
  },
  "not.my": {
    "domain": "not.my",
    "regex": ""
  },
  "notlong.com": {
    "domain": "notlong.com",
    "regex": ""
  },
  "nsfw.in": {
    "domain": "nsfw.in",
    "regex": ""
  },
  "nutshellurl.com": {
    "domain": "nutshellurl.com",
    "regex": ""
  },
  "nxy.in": {
    "domain": "nxy.in",
    "regex": ""
  },
  "nyti.ms": {
    "domain": "nyti.ms",
    "regex": ""
  },
  "o-x.fr": {
    "domain": "o-x.fr",
    "regex": ""
  },
  "oc1.us": {
    "domain": "oc1.us",
    "regex": ""
  },
  "om.ly": {
    "domain": "om.ly",
    "regex": ""
  },
  "omf.gd": {
    "domain": "omf.gd",
    "regex": ""
  },
  "omoikane.net": {
    "domain": "omoikane.net",
    "regex": ""
  },
  "on.cnn.com": {
    "domain": "on.cnn.com",
    "regex": ""
  },
  "on.mktw.net": {
    "domain": "on.mktw.net",
    "regex": ""
  },
  "onforb.es": {
    "domain": "onforb.es",
    "regex": ""
  },
  "orz.se": {
    "domain": "orz.se",
    "regex": ""
  },
  "ow.ly": {
    "domain": "ow.ly",
    "regex": ""
  },
  "ping.fm": {
    "domain": "ping.fm",
    "regex": ""
  },
  "pli.gs": {
    "domain": "pli.gs",
    "regex": ""
  },
  "pnt.me": {
    "domain": "pnt.me",
    "regex": ""
  },
  "politi.co": {
    "domain": "politi.co",
    "regex": ""
  },
  "post.ly": {
    "domain": "post.ly",
    "regex": ""
  },
  "pp.gg": {
    "domain": "pp.gg",
    "regex": ""
  },
  "profile.to": {
    "domain": "profile.to",
    "regex": ""
  },
  "ptiturl.com": {
    "domain": "ptiturl.com",
    "regex": ""
  },
  "pub.vitrue.com": {
    "domain": "pub.vitrue.com",
    "regex": ""
  },
  "qlnk.net": {
    "domain": "qlnk.net",
    "regex": ""
  },
  "qte.me": {
    "domain": "qte.me",
    "regex": ""
  },
  "qu.tc": {
    "domain": "qu.tc",
    "regex": ""
  },
  "qy.fi": {
    "domain": "qy.fi",
    "regex": ""
  },
  "r.im": {
    "domain": "r.im",
    "regex": ""
  },
  "rb6.me": {
    "domain": "rb6.me",
    "regex": ""
  },
  "read.bi": {
    "domain": "read.bi",
    "regex": ""
  },
  "readthis.ca": {
    "domain": "readthis.ca",
    "regex": ""
  },
  "reallytinyurl.com": {
    "domain": "reallytinyurl.com",
    "regex": ""
  },
  "redir.ec": {
    "domain": "redir.ec",
    "regex": ""
  },
  "redirects.ca": {
    "domain": "redirects.ca",
    "regex": ""
  },
  "redirx.com": {
    "domain": "redirx.com",
    "regex": ""
  },
  "retwt.me": {
    "domain": "retwt.me",
    "regex": ""
  },
  "ri.ms": {
    "domain": "ri.ms",
    "regex": ""
  },
  "rickroll.it": {
    "domain": "rickroll.it",
    "regex": ""
  },
  "riz.gd": {
    "domain": "riz.gd",
    "regex": ""
  },
  "rt.nu": {
    "domain": "rt.nu",
    "regex": ""
  },
  "ru.ly": {
    "domain": "ru.ly",
    "regex": ""
  },
  "rubyurl.com": {
    "domain": "rubyurl.com",
    "regex": ""
  },
  "rurl.org": {
    "domain": "rurl.org",
    "regex": ""
  },
  "rww.tw": {
    "domain": "rww.tw",
    "regex": ""
  },
  "s4c.in": {
    "domain": "s4c.in",
    "regex": ""
  },
  "s7y.us": {
    "domain": "s7y.us",
    "regex": ""
  },
  "safe.mn": {
    "domain": "safe.mn",
    "regex": ""
  },
  "sameurl.com": {
    "domain": "sameurl.com",
    "regex": ""
  },
  "sdut.us": {
    "domain": "sdut.us",
    "regex": ""
  },
  "shar.es": {
    "domain": "shar.es",
    "regex": ""
  },
  "shink.de": {
    "domain": "shink.de",
    "regex": ""
  },
  "shorl.com": {
    "domain": "shorl.com",
    "regex": ""
  },
  "short.ie": {
    "domain": "short.ie",
    "regex": ""
  },
  "short.to": {
    "domain": "short.to",
    "regex": ""
  },
  "shortlinks.co.uk": {
    "domain": "shortlinks.co.uk",
    "regex": ""
  },
  "shorturl.com": {
    "domain": "shorturl.com",
    "regex": ""
  },
  "shout.to": {
    "domain": "shout.to",
    "regex": ""
  },
  "show.my": {
    "domain": "show.my",
    "regex": ""
  },
  "shrinkify.com": {
    "domain": "shrinkify.com",
    "regex": ""
  },
  "shrinkr.com": {
    "domain": "shrinkr.com",
    "regex": ""
  },
  "shrt.fr": {
    "domain": "shrt.fr",
    "regex": ""
  },
  "shrt.st": {
    "domain": "shrt.st",
    "regex": ""
  },
  "shrten.com": {
    "domain": "shrten.com",
    "regex": ""
  },
  "shrunkin.com": {
    "domain": "shrunkin.com",
    "regex": ""
  },
  "simurl.com": {
    "domain": "simurl.com",
    "regex": ""
  },
  "slate.me": {
    "domain": "slate.me",
    "regex": ""
  },
  "smallr.com": {
    "domain": "smallr.com",
    "regex": ""
  },
  "smsh.me": {
    "domain": "smsh.me",
    "regex": ""
  },
  "smurl.name": {
    "domain": "smurl.name",
    "regex": ""
  },
  "sn.im": {
    "domain": "sn.im",
    "regex": ""
  },
  "snipr.com": {
    "domain": "snipr.com",
    "regex": ""
  },
  "snipurl.com": {
    "domain": "snipurl.com",
    "regex": ""
  },
  "snurl.com": {
    "domain": "snurl.com",
    "regex": ""
  },
  "sp2.ro": {
    "domain": "sp2.ro",
    "regex": ""
  },
  "spedr.com": {
    "domain": "spedr.com",
    "regex": ""
  },
  "srnk.net": {
    "domain": "srnk.net",
    "regex": ""
  },
  "srs.li": {
    "domain": "srs.li",
    "regex": ""
  },
  "starturl.com": {
    "domain": "starturl.com",
    "regex": ""
  },
  "su.pr": {
    "domain": "su.pr",
    "regex": ""
  },
  "surl.co.uk": {
    "domain": "surl.co.uk",
    "regex": ""
  },
  "surl.hu": {
    "domain": "surl.hu",
    "regex": ""
  },
  "t.cn": {
    "domain": "t.cn",
    "regex": ""
  },
  "t.co": {
    "domain": "t.co",
    "regex": ""
  },
  "t.lh.com": {
    "domain": "t.lh.com",
    "regex": ""
  },
  "ta.gd": {
    "domain": "ta.gd",
    "regex": ""
  },
  "tbd.ly": {
    "domain": "tbd.ly",
    "regex": ""
  },
  "tcrn.ch": {
    "domain": "tcrn.ch",
    "regex": ""
  },
  "tgr.me": {
    "domain": "tgr.me",
    "regex": ""
  },
  "tgr.ph": {
    "domain": "tgr.ph",
    "regex": ""
  },
  "tighturl.com": {
    "domain": "tighturl.com",
    "regex": ""
  },
  "tiniuri.com": {
    "domain": "tiniuri.com",
    "regex": ""
  },
  "tiny.cc": {
    "domain": "tiny.cc",
    "regex": ""
  },
  "tiny.ly": {
    "domain": "tiny.ly",
    "regex": ""
  },
  "tiny.pl": {
    "domain": "tiny.pl",
    "regex": ""
  },
  "tinylink.in": {
    "domain": "tinylink.in",
    "regex": ""
  },
  "tinyuri.ca": {
    "domain": "tinyuri.ca",
    "regex": ""
  },
  "tinyurl.com": {
    "domain": "tinyurl.com",
    "regex": ""
  },
  "tk.": {
    "domain": "tk.",
    "regex": ""
  },
  "tl.gd": {
    "domain": "tl.gd",
    "regex": ""
  },
  "tmi.me": {
    "domain": "tmi.me",
    "regex": ""
  },
  "tnij.org": {
    "domain": "tnij.org",
    "regex": ""
  },
  "tnw.to": {
    "domain": "tnw.to",
    "regex": ""
  },
  "tny.com": {
    "domain": "tny.com",
    "regex": ""
  },
  "to.": {
    "domain": "to.",
    "regex": ""
  },
  "to.ly": {
    "domain": "to.ly",
    "regex": ""
  },
  "togoto.us": {
    "domain": "togoto.us",
    "regex": ""
  },
  "totc.us": {
    "domain": "totc.us",
    "regex": ""
  },
  "toysr.us": {
    "domain": "toysr.us",
    "regex": ""
  },
  "tpm.ly": {
    "domain": "tpm.ly",
    "regex": ""
  },
  "tr.im": {
    "domain": "tr.im",
    "regex": ""
  },
  "tra.kz": {
    "domain": "tra.kz",
    "regex": ""
  },
  "trunc.it": {
    "domain": "trunc.it",
    "regex": ""
  },
  "twhub.com": {
    "domain": "twhub.com",
    "regex": ""
  },
  "twirl.at": {
    "domain": "twirl.at",
    "regex": ""
  },
  "twitclicks.com": {
    "domain": "twitclicks.com",
    "regex": ""
  },
  "twitterurl.net": {
    "domain": "twitterurl.net",
    "regex": ""
  },
  "twitterurl.org": {
    "domain": "twitterurl.org",
    "regex": ""
  },
  "twiturl.de": {
    "domain": "twiturl.de",
    "regex": ""
  },
  "twurl.cc": {
    "domain": "twurl.cc",
    "regex": ""
  },
  "twurl.nl": {
    "domain": "twurl.nl",
    "regex": ""
  },
  "u.mavrev.com": {
    "domain": "u.mavrev.com",
    "regex": ""
  },
  "u.nu": {
    "domain": "u.nu",
    "regex": ""
  },
  "u76.org": {
    "domain": "u76.org",
    "regex": ""
  },
  "ub0.cc": {
    "domain": "ub0.cc",
    "regex": ""
  },
  "ulu.lu": {
    "domain": "ulu.lu",
    "regex": ""
  },
  "updating.me": {
    "domain": "updating.me",
    "regex": ""
  },
  "ur1.ca": {
    "domain": "ur1.ca",
    "regex": ""
  },
  "url.az": {
    "domain": "url.az",
    "regex": ""
  },
  "url.co.uk": {
    "domain": "url.co.uk",
    "regex": ""
  },
  "url.ie": {
    "domain": "url.ie",
    "regex": ""
  },
  "url360.me": {
    "domain": "url360.me",
    "regex": ""
  },
  "url4.eu": {
    "domain": "url4.eu",
    "regex": ""
  },
  "urlborg.com": {
    "domain": "urlborg.com",
    "regex": ""
  },
  "urlbrief.com": {
    "domain": "urlbrief.com",
    "regex": ""
  },
  "urlcover.com": {
    "domain": "urlcover.com",
    "regex": ""
  },
  "urlcut.com": {
    "domain": "urlcut.com",
    "regex": ""
  },
  "urlenco.de": {
    "domain": "urlenco.de",
    "regex": ""
  },
  "urli.nl": {
    "domain": "urli.nl",
    "regex": ""
  },
  "urls.im": {
    "domain": "urls.im",
    "regex": ""
  },
  "urlshorteningservicefortwitter.com": {
    "domain": "urlshorteningservicefortwitter.com",
    "regex": ""
  },
  "urlx.ie": {
    "domain": "urlx.ie",
    "regex": ""
  },
  "urlzen.com": {
    "domain": "urlzen.com",
    "regex": ""
  },
  "usat.ly": {
    "domain": "usat.ly",
    "regex": ""
  },
  "use.my": {
    "domain": "use.my",
    "regex": ""
  },
  "vb.ly": {
    "domain": "vb.ly",
    "regex": ""
  },
  "vgn.am": {
    "domain": "vgn.am",
    "regex": ""
  },
  "vl.am": {
    "domain": "vl.am",
    "regex": ""
  },
  "vm.lc": {
    "domain": "vm.lc",
    "regex": ""
  },
  "w55.de": {
    "domain": "w55.de",
    "regex": ""
  },
  "wapo.st": {
    "domain": "wapo.st",
    "regex": ""
  },
  "wapurl.co.uk": {
    "domain": "wapurl.co.uk",
    "regex": ""
  },
  "wipi.es": {
    "domain": "wipi.es",
    "regex": ""
  },
  "wp.me": {
    "domain": "wp.me",
    "regex": ""
  },
  "x.vu": {
    "domain": "x.vu",
    "regex": ""
  },
  "xr.com": {
    "domain": "xr.com",
    "regex": ""
  },
  "xrl.in": {
    "domain": "xrl.in",
    "regex": ""
  },
  "xrl.us": {
    "domain": "xrl.us",
    "regex": ""
  },
  "xurl.es": {
    "domain": "xurl.es",
    "regex": ""
  },
  "xurl.jp": {
    "domain": "xurl.jp",
    "regex": ""
  },
  "y.ahoo.it": {
    "domain": "y.ahoo.it",
    "regex": ""
  },
  "yatuc.com": {
    "domain": "yatuc.com",
    "regex": ""
  },
  "ye.pe": {
    "domain": "ye.pe",
    "regex": ""
  },
  "yep.it": {
    "domain": "yep.it",
    "regex": ""
  },
  "yfrog.com": {
    "domain": "yfrog.com",
    "regex": ""
  },
  "yhoo.it": {
    "domain": "yhoo.it",
    "regex": ""
  },
  "yiyd.com": {
    "domain": "yiyd.com",
    "regex": ""
  },
  "youtu.be": {
    "domain": "youtu.be",
    "regex": ""
  },
  "yuarel.com": {
    "domain": "yuarel.com",
    "regex": ""
  },
  "z0p.de": {
    "domain": "z0p.de",
    "regex": ""
  },
  "zi.ma": {
    "domain": "zi.ma",
    "regex": ""
  },
  "zi.mu": {
    "domain": "zi.mu",
    "regex": ""
  },
  "zipmyurl.com": {
    "domain": "zipmyurl.com",
    "regex": ""
  },
  "zud.me": {
    "domain": "zud.me",
    "regex": ""
  },
  "zurl.ws": {
    "domain": "zurl.ws",
    "regex": ""
  },
  "zz.gd": {
    "domain": "zz.gd",
    "regex": ""
  },
  "zzang.kr": {
    "domain": "zzang.kr",
    "regex": ""
  },
  "\u203a.ws": {
    "domain": "\u203a.ws",
    "regex": ""
  },
  "\u2729.ws": {
    "domain": "\u2729.ws",
    "regex": ""
  },
  "\u273f.ws": {
    "domain": "\u273f.ws",
    "regex": ""
  },
  "\u2765.ws": {
    "domain": "\u2765.ws",
    "regex": ""
  },
  "\u2794.ws": {
    "domain": "\u2794.ws",
    "regex": ""
  },
  "\u279e.ws": {
    "domain": "\u279e.ws",
    "regex": ""
  },
  "\u27a1.ws": {
    "domain": "\u27a1.ws",
    "regex": ""
  },
  "\u27a8.ws": {
    "domain": "\u27a8.ws",
    "regex": ""
  },
  "\u27af.ws": {
    "domain": "\u27af.ws",
    "regex": ""
  },
  "\u27b9.ws": {
    "domain": "\u27b9.ws",
    "regex": ""
  },
  "\u27bd.ws": {
    "domain": "\u27bd.ws",
    "regex": ""
  }
}
