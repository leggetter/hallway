exports.ptype = 112; // must be unique per service, see dMap.js

exports.profile = {
  id: function(data) {
    return data && data.identity && data.identity.userId;
  }
};

exports.defaults = {
  self: 'profile'
};
