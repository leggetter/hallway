var express = require('express');

var dMap = require('dMap');
var lconfig = require('lconfig');
var servezas = require('servezas');

// This swagger-enables the API and returns required documentation JSON to
// endpoints at /resources.json and /resources/*
var app = module.exports = express.createServer();

app.set('views', __dirname + '/../../resources');
app.set('view options', { layout: false });

app.get('/services', function (req, res) {
  var services = servezas.services();
  res.header('content-type', 'application/json');
  res.render('services.ejs', {
    locals: {
      services: services,
      host: lconfig.externalBase,
      listEndpoints: require('../../resources/helpers').listEndpoints
    }
  });
});

// need to document the endpoints that are POST enabled since not consistent
var swagger_post = {
  statuses: {
    body: ['query', 'The text of the status to share']
  },
  news: {
    body: ['query', 'Text describing the link'],
    url: ['query', 'The link']
  },
  photos: {
    photo: ['body', 'The photo you wish to upload']
  }
};

app.get('/types', function (req, res) {
  res.header('content-type', 'application/json');
  var types = dMap.types(false, false);
  res.render('types.ejs', {
    locals: {
      types: types,
      post: swagger_post,
      host: lconfig.externalBase
    }
  });
});

app.get('/profile', function (req, res) {
  res.header('content-type', 'application/json');
  res.render('profile.ejs', {
    locals: {host: lconfig.externalBase}
  });
});

app.get('/friends', function (req, res) {
  res.header('content-type', 'application/json');
  res.render('friends.ejs', {
    locals: {host: lconfig.externalBase}
  });
});

app.get('/profiles', function (req, res) {
  res.header('content-type', 'application/json');
  res.render('profiles.ejs', {
    locals: {
      serviceNames: Object.keys(servezas.services()),
      host: lconfig.externalBase
    }
  });
});
