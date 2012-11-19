exports.ptype = 101; // must be unique per service, see dMap.js

// http://www.flickr.com/services/api/flickr.contacts.getList.html

function _c(val) {
  return val && val._content;
}

exports.contact = {
  id: function(data) {
      return data.nsid;
  },
  name: function(data) {
    return _c(data.realname);
  },
  photo: function(data) {
    if (!data.iconserver || parseInt(data.iconserver, 10) === 0) return null;
    return [
      "http://farm", data.iconfarm,
      ".staticflickr.com/", data.iconserver,
      "/buddyicons/", data.nsid,
      ".jpg"
    ].join("");
  },
  oembed: function(data) {
    var ret = {type:'contact'};
    ret.title = _c(data.realname);
    ret.handle = data.path_alias;
    ret.url = _c(data.profileurl);
    ret.description = _c(data.description);
    if (data.iconserver > 0) {
      ret.thumbnail_url = [
        "http://farm", data.iconfarm,
        ".staticflickr.com/", data.iconserver,
        "/buddyicons/", data.nsid,
        ".jpg"
      ].join("");
    }
    ret.provider_name = 'flickr';
    return ret;
  }
};

exports.profile = {
  name: function(data) {
    return data.realname._content;
  },
  oembed: function(data) {
    var ret = {
      type:'contact',
      title: data.realname._content,
      url: data.profileurl._content,
      provider_name: 'flickr',
      id: data.id
    };
    return ret;
  }
};

// http://www.flickr.com/services/api/flickr.people.getPhotos.html
exports.photo = {
  media: 'source',
  oembed: function(data) {
    var ret = {
      type          : 'photo',
      title         : data.title,
      url           : 'http://farm' + data.farm + '.staticflickr.com/' +
                      data.server + '/' +
                      data.id + '_' + data.secret + '_b.jpg',
      thumbnail_url : 'http://farm' + data.farm + '.staticflickr.com/' +
                      data.server + '/' +
                      data.id + '_' + data.secret + '_t.jpg',
      provider_name : 'flickr'
    };
    return ret;
  }
};

exports.defaults = {
  self: 'profile',
  photos: 'photo',
  contacts: 'contact',
  photos_feed: 'photo'
};

exports.types = {
  photos: ['photo:flickr/photos'],
  contacts: ['contact:flickr/contacts'],
  photos_feed: ['photo:flickr/photos_feed']
};
