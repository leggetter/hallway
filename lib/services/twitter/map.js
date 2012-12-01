exports.ptype = 109; // must be unique per service, see dMap.js

exports.contact = {
    photo: function(data) {
      return data.profile_image_url_https ?
        data.profile_image_url_https.replace('_normal','') : undefined;
    },
    address: {
      type:'location',
      key:'location'
    },
    nickname: 'screen_name',
    at: function(data) { return new Date(data.created_at).getTime(); },
    oembed: function(data) {
      var ret = {type:'contact'};
      ret.url = 'http://twitter.com/'+data.screen_name;
      if(data.url) ret.website = data.url;
      ret.title = data.name;
      ret.handle = data.screen_name;
      ret.description = data.description;
      if(data.profile_image_url_https) {
        ret.thumbnail_url = data.profile_image_url_https.replace('_normal','');
      }
      ret.provider_name = 'twitter';
      ret.id = data.id_str;
      if (data.location) ret.location = data.location;
      return ret;
    },
    text: 'screen_name'
};

exports.tweet = {
    id: 'id_str',
    fromName: '',
    fromId: '',
    at: function(data) { return new Date(data.created_at).getTime(); },
    ll: function(data) {
      // hack to inspect until we find any [123,456]
      function firstLL(o, reversed) {
          if (Array.isArray(o) && o.length === 2 &&
              typeof o[0] === 'number' && typeof o[1] === 'number') {
              return (reversed) ? [o[1],o[0]] : o; // reverse them optionally
          }
          if (typeof o !== 'object') return undefined;
          for (var i in o) {
              var ret = firstLL(o[i], reversed);
              if(ret) return ret;
          }
          return undefined;
      }

      // Find center of bounding boxed LL array
      function computedLL(box) {
          var allLat = 0;
          var allLng = 0;

          for (var i=0; i<box.length; ++i) {
              allLat += box[i][1];
              allLng += box[i][0];
          }
          var lat = +(allLat / 4).toFixed(5);
          var lng = +(allLng / 4).toFixed(5);

          return [lat, lng];
      }
      return firstLL(data.geo) || firstLL(data.coordinates, true) ||
        (data.place !== null && data.place.bounding_box &&
          data.place.bounding_box.coordinates &&
          computedLL(data.place.bounding_box.coordinates[0]));

    },
    urls: function(data) {
      var url = require('url');
      var urls = {};
      var ignores = {};
      // process twitter's defeind urls first
      if(data.entities && Array.isArray(data.entities.urls)) {
        data.entities.urls.forEach(function(u) {
          urls[u.expanded_url || u.url] = true;
          // if there's an expanded and it's different, that's the better one,
          // ignore the shorter (t.co) one
          if(u.expanded_url !== u.url) ignores[u.url] = true;
        });
      }
      var regexToken = /((?:https?:\/\/|www\d{0,3}[.]|[a-z0-9.\-]+[.][a-z]{2,4}\/)(?:[^\s()<>]+|\(([^\s()<>]+|(\([^\s()<>]+\)))*\))+(?:\(([^\s()<>]+|(\([^\s()<>]+\)))*\)|[^\s`!()\[\]{};:'".,<>?«»“”‘’]))/g;
      // when you use /g on a regex it magically maintains state between .exec()
      // calls, CRAZY TIMES!
      var matchArray;
      if(data.text) {
        var text = data.text;
        // This seems odd, but it works around an issue in the
        // regex that exponentialy gets more complex with trailing
        // . characters on urls
        text = text.replace(/(\.{10})/g, " $1");
        while((matchArray = regexToken.exec(text)) !== null) {
          var str = matchArray[0];
          // gotta do sanity cleanup for url.parse, it makes no assumptions
          // I guess :/
          if(str.substr(0,4).toLowerCase() !== "http") str = "http://"+str;
          if(str.indexOf('&quot') === str.length - 5) str = str.substr(0,
            str.indexOf('&quot')); // stupid twitter escaping
          var u = url.parse(str);
          // TODO: fully normalize
          if(!u.host || u.host.indexOf(".") <= 0 ||
            u.host.length - u.host.indexOf(".") < 3) continue;
          // empty hash is nothing, normalize that by a pound
          if(u.hash === '#') u.hash = '';
          var uf = url.format(u);
          if(ignores[uf]) continue; // skip ones we know about already
          urls[uf] = true;
        }
      }
      urls = Object.keys(urls);
      return urls.length > 0 ? urls : undefined;
    },
    text: 'text',
    author: function(data) {
      if(!data.user) return undefined;
      var ret = {};
      ret.name =  data.user.name;
      ret.url = 'http://twitter.com/'+data.user.screen_name;
      ret.photo = data.user.profile_image_url_https;
      return ret;
    },
    participants: function(data) {
      var ret = {};
      if(data.user) ret[data.user.id_str] = {"author": true};
      if(data.in_reply_to_user_id_str) {
        ret[data.in_reply_to_user_id_str] = ret[data.in_reply_to_user_id_str] ||
          {};
      }
      if(data.entities && Array.isArray(data.entities.user_mentions)) {
        data.entities.user_mentions.forEach(function(mention){
          if(mention.id_str) ret[mention.id_str] = ret[mention.id_str] || {};
        });
      }
      var rtid = data.retweeted_status && data.retweeted_status.user &&
        data.retweeted_status.user.id_str;
      if(rtid) ret[rtid] = ret[rtid] || {};
      return (Object.keys(ret).length > 0) ? ret : undefined;
    }
};

exports.related = {
    id: '_id'
};

exports.pumps = {
  types: {
    tweet: function(entry) {
      if(!entry.types) entry.types = {};
      // before state
      var pre = Object.keys(entry.types).length;
      // first way could be a link
      if(entry.data.entities && entry.data.entities.urls &&
        entry.data.entities.urls.length > 0) entry.types.link=true;
      if(entry.refs) Object.keys(entry.refs).forEach(function(ref){
        if(ref.indexOf(':links/oembed') === -1) return;
        var type = ref.substring(0, ref.indexOf(':'));
        if(type && type.length > 0) entry.types[type] = true;
      });
      // only status type if none else above!
      if(Object.keys(entry.types).length === pre) entry.types.status = true;
    }
  }
};

exports.types = {
  photos: ['photo:twitter/tweets'],
  photos_feed: ['photo:twitter/timeline'],
  news: ['link:twitter/tweets'],
  news_feed: ['link:twitter/timeline'],
  videos: ['video:twitter/tweets'],
  videos_feed: ['video:twitter/timeline'],
  statuses: ['status:twitter/tweets'],
  statuses_feed: ['status:twitter/timeline'],
  contacts: ['contact:twitter/friends']
};

exports.defaults = {
  friends: 'contact',
  followers: 'contact',
  timeline: 'tweet',
  mentions: 'tweet',
  favorites: 'tweet',
  tweets: 'tweet',
  self: 'contact'
};

var crypto = require('crypto');

exports.guid = {
  'tweet': function(entry) {
    var match;
    var refs = entry.refs && Object.keys(entry.refs) || [];

    for(var i = 0; i < refs.length; i++) {
      var ref = refs[i];

      // match instagrammys
      if((match = /instagr.am\/p\/([^\/]+)\//.exec( ref ))) {
        return 'guid:instagram/#' + match[1];
      }

      // match checkins
      if((match = /foursquare\.com\/[^\/]+\/checkin\/(\w+)/.exec( ref ))) {
        return 'guid:foursquare/#' + match[1];
      }
    }

    // fallback to just dumb text guiding
    return 'guid:' + entry.data.user.screen_name + '@twitter/#' +
      crypto.createHash('md5').update(entry.data.text).digest('hex');
  }
};
