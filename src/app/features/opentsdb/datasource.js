define([
  'angular',
  'lodash',
  'kbn',
  'moment',
  './queryCtrl',
],
function (angular, _, kbn) {
  'use strict';

  var module = angular.module('grafana.services');
  var _aliasRegex = /\$(\w+)|\[\[([\s\S]+?)\]\]/g;

  module.factory('OpenTSDBDatasource', function($q, $http, templateSrv) {

    function OpenTSDBDatasource(datasource) {
      this.type = 'opentsdb';
      this.editorSrc = 'app/features/opentsdb/partials/query.editor.html';
      this.url = datasource.url;
      this.name = datasource.name;
      this.supportMetrics = true;
      this.lastLookupType = '';
      this.lastLookupQuery = '';
      this.lastLookupResults = [];
      this.annotationEditorSrc = 'app/features/opentsdb/partials/annotations.editor.html';
      this.supportAnnotations = true;
    }

    OpenTSDBDatasource.prototype.annotationQuery = function(annotationOrigin, rangeUnparsed) {
      var start = convertToTSDBTime(rangeUnparsed.from);
      var end = convertToTSDBTime(rangeUnparsed.to);

      var queryString = templateSrv.replace(annotationOrigin.query) || '*';

      var options = {
        method: 'GET',
        url: this.url + '/api/query',
        params: {
          'start': start,
          'end': end,
          m: 'sum:'+queryString
        }
      };

      return $http(options).then(function(response) {
        return _.flatten(_.map(response.data, function(dataset) {
          return _.map(dataset['annotations'], function(annotation) {
            var event = {
              annotation: annotationOrigin,
              min: annotation.startTime * 1000,
              max: annotation.endTime * 1000,
              title: annotation.description,
              text: annotation.notes
            };
            return event;
          });
        }));
      });
    };

    // Called once per panel (graph)
    OpenTSDBDatasource.prototype.query = function(options) {
      var start = convertToTSDBTime(options.range.from);
      var end = convertToTSDBTime(options.range.to);
      var queries = _.compact(_.map(options.targets, convertTargetToQuery));

      // No valid targets, return the empty result to save a round trip.
      if (_.isEmpty(queries)) {
        var d = $q.defer();
        d.resolve({ data: [] });
        return d.promise;
      }

      var groupByTags = {};
      _.each(queries, function(query) {
        _.each(query.tags, function(val, key) {
          groupByTags[key] = true;
        });
      });

      return this.performTimeSeriesQuery(queries, start, end)
        .then(_.bind(function(response) {
          var result = _.map(response.data, _.bind(function(dataset) {
            // try and match the request of each response with the grafana target/query that instantiated it
            // to help clarify; t & target[s] is the query within the grafana interface.  dataset is the OpenTSDB result from the query
            var target = _.filter(this.targets, function(t) {
              if (dataset.metric !== t.metric) {
                return false; // metrics are different, don't bother
              }
              if (_.size(t.tags) === 0) {
                return true; // no tags to compare, so cut the trip short
              }
              // metrics match, so lets look for differences in tags
              // but, before we can do any tag-matching, we need to expand any template variables used in any tags
              var tags = {};
              _.each(t.tags, function(v, k) {
                k = templateSrv.replace(k);
                v = templateSrv.replace(v);
                if ((v !== "*") && (k !== "*")) {
                  tags[k] = v;
                }
              });
              return (_.where([dataset.tags], tags).length > 0);
            });
            if ((target.length <= 0) && (this.targets.length >= 1)) {
              target[0] = this.targets[0];
            }

            return transformMetricData(dataset, groupByTags, target[0]);
          }, this));
          // this is the last point at which we can add 'annotations' to our result (since we don't even get results prior till now)
          // so, interate through each result entry, looking for and 'annotations' key, and move it out of the result's sub-object
          /*
          var annotations = [];
          _.each(result, function(series, index) {
            if (series && series.annotations) {
              annotations = _.union(annotations, series.annotations);
              delete series['annotations'];
            }
          });
          return { data: result, annotations: annotations };
          */
          return { data: result };
        }, options));
    };

    OpenTSDBDatasource.prototype.performTimeSeriesQuery = function(queries, start, end) {
      var reqBody = {
        start: start,
        queries: queries,
        globalAnnotations: true
      };

      // Relative queries (e.g. last hour) don't include an end time
      if (end) {
        reqBody.end = end;
      }

      var options = {
        method: 'POST',
        url: this.url + '/api/query',
        data: reqBody
      };

      return $http(options);
    };

    OpenTSDBDatasource.prototype.performSuggestQuery = function(query, type, target) {
      var that = this;
      var options = {
        method: 'GET',
        url: this.url + '/api/suggest',
        params: {
          type: type,
          q: query,
          max: 99999

        }
      };
      return $http(options).then(function(result) {
        result.data.sort();

        if ((type === 'metrics' || !target.metric) && _.isEmpty(target.tags)) {
          return result.data;
        }

        return that.performSearchLookup(type, target).then(function(lookupResults) {
          // var output = intersect_safe(that.lastLookupResults, result.data);
          var output = intersect_safe(lookupResults, result.data);
          //console.log("lookupResults: " + JSON.stringify(lookupResults));
          //console.log("that.lastLookupResults: " + JSON.stringify(that.lastLookupResults));
          //console.log("result.data: " + JSON.stringify(result.data));
          //console.log("output: " + JSON.stringify(output));
          return output;
        });
      });
    };

    OpenTSDBDatasource.prototype.performSearchLookup = function(type, target) {
      var that = this;
      var searchTags = [];
      if (!_.isEmpty(target.tags)) {
        _.each(_.pairs(target.tags), function(tag) {
          searchTags.push(tag[0] + '=' + tag[1]);
        });
      }
      if (type === 'tagv') {
        if (target.currentTagKey) {
          searchTags.push(target.currentTagKey+'=*');
        }
      } else if (type === 'tagk') {
        if (target.currentTagValue) {
          searchTags.push('*='+target.currentTagValue);
        }
      }

      var search = '';
      if (type !== 'metrics') {
        search += target.metric;
      }
      search += '{' + searchTags.join(',') + '}';

      // /api/search/lookup can be an expensive operation, so we cache our most recent results and re-use them is possible
      if ((type === this.lastLookupType) && (this.lastLookupQuery === search)) {
        // goofy promise stuff... so we need to wrap up the result in the promise
        return $q(function(resolve) {
          resolve(that.lastLookupResults);
        });
      }

      return this.doSearchLookup(type, search, function(result) {
        // iterate through the results and find all the available/matching tags & values
        var resultSet = new Set();
        _.each(result.data.results, function(lookupResults) {
          if (type === 'metrics') {
            resultSet.add(lookupResults.metric);
          } else {
            _.each(_.pairs(lookupResults.tags), function(tag) {
              if (type === 'tagk') {
                if (!target.currentTagValue || (target.currentTagValue === tag[1])) {
                  resultSet.add(tag[0]);
                }
              } else {
                if (!target.currentTagKey || (target.currentTagKey === tag[0])) {
                  resultSet.add(tag[1]);
                }
              }
            });
          }
        });
        // Grunt doesn't like this, I guess because its ECMAScript 6?
        // var resultsOut = [v for (v of resultSet)].sort();
        var resultsOut = [];
        resultSet.forEach(function(k,v) {
          resultsOut.push(v);
        });
        resultsOut.sort();

        // console.log("Lookup Results: " + JSON.stringify(resultsOut));
        that.lastLookupResults = resultsOut;
        return resultsOut;
      });
    };

    OpenTSDBDatasource.prototype.metricFindQuery = function(query) {
      var type = 'metric';
      var expandedQuery = templateSrv.replace(query);
      var match;
      try {
        var parts = expandedQuery.split(/[{}]/);
        match = parts[0];
        if (match.indexOf('*')) {
          // search/lookup doesn't support wildcards, its either a specific metric, or all metrics
          // if there is a wildcard, strip the metric search from the query, but keep it for matching
          expandedQuery='{'+parts[1]+'}';
        }
        var tagString = parts[1];
        tagString.replace(/(\b[^=]+)=(\b[^,]+|\*)/g, function ($0, key, val) {
          if (val === '*') {
            match = key;
            type = 'tagv';
          } else if (key === '*') {
            match = val;
            type = 'tagk';
          }
        });
      }
      catch (err) {
        return $q.reject(err);
      }

      return this.doSearchLookup(type, expandedQuery, function(searchResult) {
        // iterate through the results and find all the available/matching tags & values

        var resultSet = new Set();
        _.each(searchResult.data.results, function(item) {
          if (type === 'metric') {
            if ((match === '') || (match === '*')) {
              resultSet.add(item.metric);
            } else {
              var wildPos = match.indexOf('*');
              if (wildPos !== 0) {
                var startMatch = match.substring(0, match.indexOf('*'));
                var endMatch = match.substring(match.indexOf('*')+1, match.length);

                var startsWith = (item.metric.indexOf(startMatch) === 0);
                var endsWith = (item.metric.indexOf(endMatch, item.metric.length - endMatch.length) !== -1);
                if (startsWith && endsWith) {
                  resultSet.add(item.metric);
                }
              } else if (item.metric === match) {
                // this matches only a specific metric name, which isn't very useful
                resultSet.add(item.metric);
              }
              // ignore everything else
            }
          } else {
            _.each(_.pairs(item.tags), function(tag) {
              if ((type === 'tagk') && (match === tag[1])) {
                resultSet.add(tag[0]);
              } else if ((type === 'tagv') && (match === tag[0])) {
                resultSet.add(tag[1]);
              }
            });
          }
        });
        // Grunt doesn't like this, I guess because its ECMAScript 6?
        // var resultsOut = [v for (v of resultSet)].sort();
        // return _.map([...resultSet], function(name) {
        var resultsOut = [];
        resultSet.forEach(function(k,v) {
          resultsOut.push({
            text: v,
            expandable: false
          });
        });
        resultsOut.sort();
        return resultsOut;
      });
    };

    OpenTSDBDatasource.prototype.doSearchLookup = function(type, query, handler) {
      this.lastLookupQuery = query;
      this.lastLookupType = type;

      var options = {
        method: 'GET',
        url: this.url + '/api/search/lookup',
        params: {
          m: query
        },
      };

      return $http(options).then(handler);
    };

    function transformMetricData(md, groupByTags, options) {
      var dps = [],
          annotations = [],
          metricLabel = null;

      metricLabel = createMetricLabel(md.metric, md.tags, groupByTags, options);

      // TSDB returns datapoints has a hash of ts => value.
      // Can't use _.pairs(invert()) because it stringifies keys/values
      _.each(md.dps, function (v, k) {
        dps.push([v, k * 1000]);
      });

      return { target: metricLabel, datapoints: dps, annotations: annotations };
    }

    function expandVariables(text, scope) {
      return text.replace(_aliasRegex, function(match, g1, g2) {
        var value = scope[g1 || g2];
        if (!value) { return match; }
        return value;
      });
    }

    function createMetricLabel(metric, tags, groupByTags, options) {
      var distinctTags = {};

      if (!_.isEmpty(tags)) {
        _.each(_.pairs(tags), function(tag) {
          if (_.has(groupByTags, tag[0])) {
            distinctTags[tag[0]] = tag[1];
          }
        });
      }

      if (!_.isUndefined(options) && options.alias) {
        var scope = _.clone(tags);
        scope["metric"] = metric;
        return expandVariables(options.alias, scope);
      }

      if (!_.isEmpty(distinctTags)) {
        var tagText = _.map(distinctTags, function(v, k) { return k+"="+v; });
        metric += "{" + tagText.join(", ") + "}";
      }

      return metric;
    }

    function convertTargetToQuery(target) {
      if (!target.metric) {
        return null;
      }

      var query = {
        metric: templateSrv.replace(target.metric),
        aggregator: "avg"
      };

      if (target.aggregator) {
        query.aggregator = templateSrv.replace(target.aggregator);
      }

      if (target.shouldComputeRate) {
        query.rate = true;
        query.rateOptions = {
          counter: !!target.isCounter
        };

        if (target.counterMax && target.counterMax.length) {
          query.rateOptions.counterMax = parseInt(target.counterMax);
        }

        if (target.counterResetValue && target.counterResetValue.length) {
          query.rateOptions.resetValue = parseInt(target.counterResetValue);
        }
      }

      if (target.shouldDownsample) {
        query.downsample = templateSrv.replace(target.downsampleInterval) + "-" + target.downsampleAggregator;
      }

      query.tags = angular.copy(target.tags);
      if(query.tags){
        for(var key in query.tags){
          query.tags[key] = templateSrv.replace(query.tags[key]);
        }
      }

      return query;
    }

    function convertToTSDBTime(date) {
      if (date === 'now') {
        return null;
      }

      date = kbn.parseDate(date);

      return date.getTime();
    }

    function intersect_safe(a, b) {
      var ai = 0;
      var bi = 0;
      var result = [];

      while(ai < a.length && bi < b.length) {
        if (a[ai] < b[bi]) {
          ai++;
        } else if (a[ai] > b[bi]) {
          bi++;
        } else { /* they're equal */
          result.push(a[ai]);
          ai++;
          bi++;
        }
      }

      return result;
    }

    return OpenTSDBDatasource;
  });

});
