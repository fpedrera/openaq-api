'use strict';

var _ = require('lodash');

import { db } from '../services/db';
var utils = require('../../lib/utils');

var cacheName = 'LATEST';

/**
* Get latest for all locations. Implements all protocols supported by /latest endpoint
*
* @param {Object} query - Payload contains query paramters and their values
* @param {recordsCallback} cb - The callback that returns the records
*/
module.exports.query = function (query, redis, checkCache, cb) {
  // Save payload to use for caching
  var oPayload = _.cloneDeep(query);

  var sendResults = function (err, data) {
    cb(err, data, data.length);
  };

  var queryDatabase = function () {
    // Turn the payload into something we can use with psql
    let { payload, operators, betweens, nulls, notNulls } = utils.queryFromParameters(query);

    let resultsQuery = db
                        .from('measurements')
                        .select(db.raw('distinct on (location, city, parameter) location, city, parameter, date_utc, unit, country, city, ST_AsGeoJSON(coordinates) as coordinates, first_value(value) over (partition by location, parameter order by date_utc desc) as value'));

    // Build on base query
    resultsQuery = utils.buildSQLQuery(resultsQuery, payload, operators, betweens, nulls, notNulls);

    resultsQuery.then((results) => {
      // Make the results look nicer
      results = groupResults(results);

      // Send result to client
      sendResults(null, results);

      // Save the data to cache
      redis.set(utils.payloadToKey(cacheName, oPayload), JSON.stringify(results));
    })
    .catch((err) => {
      sendResults(err);
    });
  };

  // Send back cached result if we have it and it matches our cached search
  if (checkCache && redis.ready) {
    redis.get(utils.payloadToKey(cacheName, oPayload), function (err, reply) {
      if (err) {
        console.error(err);
      } else if (reply) {
        try {
          var data = JSON.parse(reply);
          return sendResults(null, data);
        } catch (e) {
          console.error(e);
        }
      }

      // If we're here, try a database query since Redis failed us
      queryDatabase();
    });
  } else {
    // Query database if we have no Redis connection
    queryDatabase();
  }
};

/**
* This is a big ugly function to group the results from the db into something
* nicer for display.
*
* @param {Array} docs - The db aggregation results
*/
var groupResults = function (docs) {
  var grouped = _.groupBy(docs, 'location');
  var final = [];
  _.forEach(grouped, function (m) {
    var measurements = _.map(m, function (m) {
      return {
        parameter: m.parameter,
        value: m.value,
        lastUpdated: m.date_utc,
        unit: m.unit
      };
    });
    var f = {
      location: m[0].location,
      city: m[0].city,
      country: m[0].country,
      measurements: measurements
    };

    // If we have coordinates, add them
    if (m[0].coordinates) {
      f.coordinates = {
        longitude: JSON.parse(m[0].coordinates).coordinates[0],
        latitude: JSON.parse(m[0].coordinates).coordinates[1]
      };
    }

    final.push(f);
  });

  return final;
};
