exports.ptype = 102; // must be unique per service, see dMap.js

exports.contact = {
  name: function(data) {
      return data.firstName + (data.lastName? ' ' + data.lastName: '');
  },
  oembed: function(data) {
    var ret = {type:'contact'};
    ret.url = data.canonicalUrl;
    if (data.firstName || data.lastName) ret.title = '';
    if (data.firstName) ret.title = data.firstName;
    if (data.lastName) ret.title += ' ' + data.lastName;
    if (data.bio) ret.description = data.bio;
    ret.thumbnail_url = data.photo;
    if (data.contact.email) ret.email = data.contact.email;
    if (data.contact.twitter) ret.handle = data.contact.twitter;
    if (data.contact.phone) ret.phone = data.contact.phone;
    ret.provider_name = 'foursquare';
    ret.id = data.id;
    if (data.homeCity) ret.location = data.homeCity;
    return ret;
  },
  text: function(data) {
    var ret = [];
    if (data.contact && data.contact.email) ret.push(data.contact.email);
    if (data.contact && data.contact.twitter) ret.push(data.contact.twitter);
    return ret.length > 0 ? ret.join(' ') : undefined;
  }
};

exports.checkin = {
  at: function(data) {
    return data.createdAt * 1000;
  },
  ll: function(data) {
    // venueless happens
    var loc = data.venue ? data.venue.location : data.location;
    return (loc && loc.lat && loc.lng) ? [loc.lat, loc.lng] : undefined;
  },
  oembed: function(data) {
    // only oembed venues
    var loc = (data.venue && data.venue.location) || data.location;
    var ret = {type:'checkin'};
    if (loc) {
      if (loc.lat) ret.lat = loc.lat;
      if (loc.lng) ret.lng = loc.lng;
    }
    ret.title = (data.venue && data.venue.name) ||
                (data.location && data.location.name);
    ret.url = data.url;
    ret.provider_name = 'foursquare';
    if (data.user) {
      ret.provider_url =
        'https://foursquare.com/user/' + data.user.id + '/checkin/' + data.id;
    }
    if (data.user && data.user.firstName) {
      ret.author_name = data.user.firstName + ' ' + data.user.lastName;
    }
    return ret;
  },
  author: function(data) {
    if (!data.user) return;
    var ret = {};
    ret.name =  data.user.firstName + ' ' + data.user.lastName;
    ret.url = 'http://foursquare.com/user/'+data.user.id;
    ret.photo = data.user.photo;
    return ret;
  },
  participants: function(data) {
    var ret = {};
    if (data.user) ret[data.user.id] = {"author": true};
    if (data.likes && Array.isArray(data.likes.groups)) {
      data.likes.groups.forEach(function(group) {
        if (Array.isArray(group.items)) {
          group.items.forEach(function(item) {
            if (item.id) ret[item.id] = ret[item.id] || {};
          });
        }
      });
    }
    if (data.comments && Array.isArray(data.comments.items)) {
      data.comments.items.forEach(function(item){
        if (item.user && item.user.id) ret[item.user.id] = ret[item.user.id] || {};
      });
    }
    return (Object.keys(ret).length > 0) ? ret : undefined;
  }
};

exports.photo = {
  at: function(data) {
    return data.createdAt * 1000;
  },
  oembed: function(data, idr) {
    var ret = {type:'photo'};
    if (data.checkin && data.checkin.about) ret.title = data.checkin.about;
    if (!ret.title && data.venue && data.venue.name) ret.title = data.venue.name;
    ret.height = data.sizes.items[0].height;
    ret.width = data.sizes.items[0].width;
    ret.url = data.url;
    ret.provider_name = 'foursquare';
    if (data.checkin && idr) {
      ret.provider_url = 'https://foursquare.com/user/' + idr.auth +
                         '/checkin/' + data.checkin.id;
    }
    // would be nice to have name here but that's in the auth.profile (TODO to make it part of dMap?)
    return ret;
  }
};

// special type for a photo checkin
exports.photoci = {
  oembed: function(data) {
    if (!data.photos || !data.photos.items || data.photos.items.length === 0) {
      return;
    }
    var ret = {type:'photo'};
    if (data.shout) ret.title = data.shout;
    if (!ret.title && data.venue && data.venue.name) ret.title = data.venue.name;
    ret.height = data.photos.items[0].sizes.items[0].height;
    ret.width = data.photos.items[0].sizes.items[0].width;
    ret.url = data.photos.items[0].url;
    ret.provider_name = 'foursquare';
    if (data.user) {
      ret.provider_url = 'https://foursquare.com/user/' + data.user.id +
                         '/checkin/' + data.id;
    }
    if (data.user && data.user.firstName) {
      ret.author_name = data.user.firstName + ' ' + data.user.lastName;
    }
    return ret;
  }
};

exports.defaults = {
  friends: 'contact',
  recent: 'checkin',
  checkins: 'checkin',
  photos: 'photo',
  badges: 'badge',
  self: 'contact'
};

exports.types = {
  photos: ['photo:foursquare/photos'],
  photos_feed: ['photoci:foursquare/recent'],
  checkins: ['checkin:foursquare/checkins'],
  checkins_feed: ['checkin:foursquare/recent'],
  contacts: ['contact:foursquare/friends']
};

exports.pumps = {
  types: {
    checkin: function(entry) {
      if (!entry.types) entry.types = {};
      if (entry.data.photos && entry.data.photos.count > 0) {
        entry.types.photoci = true;
      }
    }
  }
};

var crypto = require('crypto');

exports.guid = {
  'checkin': function(entry) {
    var guids = [];
    guids.push('guid:foursquare/#' + entry.data.id);
    if (entry.data.source && entry.data.source.name === "Instagram" &&
        entry.data.shout && entry.data.shout.length > 0) {
      var guid = crypto.createHash('md5')
                  .update(entry.data.shout).digest('hex');
      guids.push('caption:instagram/#' + guid);
    }
    return guids.join(' ');
  },
  'photo': function(entry) {
    if (!entry.data.checkin) return;
    return 'guid:foursquare/#'+entry.data.checkin.id;
  }
};
