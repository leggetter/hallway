exports.account = {
  id: 'Id',
  oembed: function(data) {
    var ret = {
      id: data.Id,
      title: data.Name,
      location: data.City + ' ' + data.State,
      provider_name: 'dwolla'
    };
    return ret;
  }
}

exports.defaults = {
  self: 'account'
}

