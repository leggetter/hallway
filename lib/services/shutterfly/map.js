exports.ptype = 115; // must be unique per service, see dMap.js

function val(dat)
{
  return Array.isArray(dat) && dat[0];
}

exports.user = {
  id: function(data){ return val(data["openfly:userid"]); },
  oembed: function(data) {
    var ret = {type:'contact'};
    ret.title = val(data['user:firstName']) + ' ' + val(data['user:lastName']);
    ret.email = val(data['user:email']);
    ret.provider_name = 'shutterfly'
    return ret;
  }  
};

exports.defaults = {
  self: 'user'
};
