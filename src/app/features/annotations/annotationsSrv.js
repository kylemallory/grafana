define([
  'angular',
  'lodash',
  'moment',
  './editorCtrl'
], function (angular, _, moment) {
  'use strict';

  var module = angular.module('grafana.services');

  module.service('annotationsSrv', function(datasourceSrv, $q, alertSrv, $rootScope, $sanitize) {
    var promiseCached;
    var list = [];
    var timezone;

    this.init = function() {
      $rootScope.onAppEvent('refresh', this.clearCache);
      $rootScope.onAppEvent('setup-dashboard', this.clearCache);
    };

    this.clearCache = function() {
      promiseCached = null;
      list = [];
    };

    this.getAnnotations = function(rangeUnparsed, dashboard) {
      if (!dashboard.annotations.enable) {
        return $q.when(null);
      }

      if (promiseCached) {
        return promiseCached;
      }

      timezone = dashboard.timezone;
      var annotations = _.where(dashboard.annotations.list, { enable: true });

      var promises  = _.map(annotations, function(annotation) {
        var datasource = datasourceSrv.get(annotation.datasource);

        return datasource.annotationQuery(annotation, rangeUnparsed)
          .then(this.receiveAnnotationResults)
          .then(null, errorHandler);
      }, this);

      promiseCached = $q.all(promises)
        .then(function() {
          return list;
        });

      return promiseCached;
    };

    this.receiveAnnotationResults = function(results) {
      for (var i = 0; i < results.length; i++) {
        addAnnotation(results[i]);
      }
    };

    function errorHandler(err) {
      console.log('Annotation error: ', err);
      var message = err.message || "Annotation query failed";
      alertSrv.set('Annotations error', message,'error');
    }

    function addAnnotation(options) {
      var title = $sanitize(options.title);
      var tooltip = ''; // "<small><b>" + title + "</b><br/>";
      var endTime = options.time;
      var startTime = options.time;
      if (options.min) {
        startTime = options.min;
      }
      if (options.max) {
        endTime = options.max;
      }

      if (options.tags) {
        var tags = $sanitize(options.tags);
        tooltip += '<span class="tag label label-tag">' + (tags || '') + '</span><br/>';
      }

      if (timezone === 'browser') {
        if (endTime) {
          tooltip += '<i><b>Start:</b> ' + moment(startTime).format('YYYY-MM-DD HH:mm:ss') + '</i> ';
          tooltip += '<i><b>End:</b> ' + moment(endTime).format('YYYY-MM-DD HH:mm:ss') + '</i><br/>';
        } else {
          tooltip += '<i>' + moment(startTime).format('YYYY-MM-DD HH:mm:ss') + '</i><br/>';
        }
      }
      else {
        if (endTime) {
          tooltip += '<i>Start: ' + moment.utc(startTime).format('YYYY-MM-DD HH:mm:ss') + '</i><br/>';
          tooltip += '<i>End: ' + moment.utc(endTime).format('YYYY-MM-DD HH:mm:ss') + '</i><br/>';
        } else {
          tooltip += '<i>' + moment.utc(startTime).format('YYYY-MM-DD HH:mm:ss') + '</i><br/>';
        }
      }

      if (options.text) {
        var text = $sanitize(options.text);
        tooltip += text.replace(/\n/g, '<br/>');
      }

      tooltip += "</small>";

      list.push({
        annotation: options.annotation,
        min: startTime,
        max: endTime,
        eventType: options.annotation.name,
        title: title,
        description: tooltip,
        score: 1
      });
    }

    // Now init
    this.init();
  });

});
