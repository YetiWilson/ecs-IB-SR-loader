

/***************************************************************************************************************
****************************************************************************************************************

This is a microservice that pulls EMC install base from Ops Console.
It runs continuously, hosted on Pivotal Cloud Foundry. Every 24 hours it queries the ops console API:

- Pulls the current master list of customer GDUNs from the ECS repo.
- Iterates through all of the customer GDUNs specified in the master list.
- For each customer GDUN, it pulls the install base data from ops-console and stores the result in JSON format in ECS.

The result is a list of objects (number of objects = number of GDUNS) stored in ECS.
The name format used is <GDUN>.json.

The objects can then be queried by middle tier apps like munger1 to ultimately return answers to questions like:
'How many VNXs does CustomerXYZ have?'

/***************************************************************************************************************
****************************************************************************************************************/


var AWS = require( "aws-sdk" ), // use the generic AWS SDK for s3 API
	ECS = require( "aws-sdk" ), // use a specific config for pointing to ECS
	request = require( "request" ), // use the request library to make http call to ops-console API
	csv = require ("csv"), //used to work with CSV files
	async = require( "async" ); // use the async library to structure sequencing of load and store logic

// setup ECS config to point to Bellevue lab
var ECSconfig = {
  s3ForcePathStyle: true,
  endpoint: new AWS.Endpoint('http://10.4.44.125:9020')
};
ECS.config.loadFromPath('./ECSconfig.json');
console.log(ECSconfig);
var ecs = new ECS.S3(ECSconfig);
console.log(ecs);

cycleThru();

// This is the master function that calls the 2 supporting functions in series to
// 1) get the list of GDUNS and then 2) process each one
function cycleThru() {
	console.log("in cycleThru now");
	var customerListSource = 'PNWandNCAcustomers.json',
		GDUNarray = [];

    async.series([
        // get customer GDUN list from ECS object store
        function(callback) {
            getCustomerList(customerListSource, function(err, GDUNS) {
                if (err) return callback(err); // return prevents a double callback with process continuing
				GDUNarray = GDUNS;
				console.log(GDUNarray[0]);
				callback(); // this is the callback saying this function is complete
            });
        },

        // get install base data for each product family and from each gdun, extract insight, and post to s3
        function(callback) {
            processGDUN(GDUNarray, function(err) {
				if (err) {
					callback(err);
				} else {
					callback(); // this is the callback saying this function is complete
				}
            });
        },
    ], function(err) {
		//restart the whole cycle again from the top after wait time
		console.log('now waiting 24 hrs before re-loading IB data');
		//sleep.sleep(86400); // wait 24 hrs
		//cycleThru();
    });
}

// This function gets the master list of customer GDUNs from the ECS repo.
// It returns that list as the 'GDUNS' array.
function getCustomerList(source, callback) {
	// get json data object from ECS bucket
	console.log("In getCustomerList");
	var GDUNS = [];
	var params = {
			Bucket: 'testSRS',
			Key: source
	};
	console.log(params);
	ecs.getObject(params, function(err, data) {
		if (err) {
			console.log(err + ' error from getobject');
			callback(err, null); // this is the callback saying getCustomerList function is complete but with an error
		} else { // success
			//console.log(data.Body.toString()); // note: Body is outputted as type buffer which is an array of bytes of the body, hence toString()
			var dataPayload = JSON.parse(data.Body);
			console.log(dataPayload.length + "dataPayload.length");
			// load GDUNS array
			for (var i = 0; i < dataPayload.length; i++) {
				console.log(dataPayload[i].gduns + "datapayload ouput");
				GDUNS.push(dataPayload[i].gduns);
			}

			// free up memory
			data = null;
			dataPayload = null;

			callback(null, GDUNS)  // this is the callback saying getCustomerList function is complete
		}
	});
}

// This function iterates through all of the customer GDUNs, pulling the install base data from ops-console
// for each GDUN, and then storing the result in JSON format in ECS.
function processGDUN(GDUNlist, callback) {
	async.forEachSeries(GDUNlist, function(gdun, callback) {
		var jsonBodyToStore;

		async.series([
			// Pull install base data from ops-console
			function(callback) {
				getOPSjson(gdun, "installs", function(err, jsonBody) {
					if (err) {
						console.log('Error getting install base data for GDUN: ' + gdun + '\n       Error = ' + err);
						callback(err); // this is the task callback saying this function is complete but with an error;
					} else {
						jsonBodyToStore = jsonBody;
						callback(); // this is the task callback saying this function is complete;
					}
				});
			},
			// Store the resulting insight in ECS
			function(callback) {
				storeECSjson(gdun, jsonBodyToStore, "testInstalls", function(err, eTag) {
					if (err) return callback(err); // task callback saying this function is complete but with an error, return prevents double callback
					callback(); // this is the task callback saying this function is complete;
				});
			},
			function(callback) {
				getOPSjson(gdun, "srs", function(err, jsonBody) {
					if (err) {
						console.log('Error getting install base data for GDUN: ' + gdun + '\n       Error = ' + err);
						callback(err); // this is the task callback saying this function is complete but with an error;
					} else {
						jsonBodyToStore = jsonBody;
						callback(); // this is the task callback saying this function is complete;
					}
				});
			},
			// Store the resulting insight in ECS
			function(callback) {
				storeECSjson(gdun, jsonBodyToStore, "testSRS", function(err, eTag) {
					if (err) return callback(err); // task callback saying this function is complete but with an error, return prevents double callback
					callback(); // this is the task callback saying this function is complete;
				});
			},
		], function(err) { // this function gets called after the two tasks have called their "task callbacks"
			if (err) {
				callback(err); // this is the callback saying this run-thru of the series is complete for a given gdun in the async.forEach but with error
			} else {
				// wait 5 seconds before callback to space out ops-console API calls and not overload source
				console.log ('waiting for 5 seconds to space out ops-console API calls');
				//sleep.sleep(5) // sleep for 5 seconds <--- NOT WORKING RIGHT NOW, BREAKS THE ASYNC FLOW
				callback()
			}
		});

	}, 	function(err) {
			if (err) return callback(err);
			callback(); // this is the callback saying all items in the async.forEach are completed
	});
}

// This function pulls the install base data for a given GDUN from ops-console
// and then provides the resulting json body in a callback to the calling function.
function getOPSjson(gdun, resty, callback) {

	var nineDigitGdun = appendZeros(gdun);

	// build the URL for the API call
	var url = "http://pnwreport.bellevuelab.isus.emc.com/api/" + resty + "/" + nineDigitGdun;

	// pull the results from the API call
	request(url, function (error, response, body) {
		if (error) {
			callback(err);
		} else { // install base data was successfully loaded
			callback(null, body); // this is the  callback saying this getIBdata function is complete;
		}
	});
}
// This function stores json in requested ECS bucket
function storeECSjson(gdun, jsonBodyToStore, ECSbucket, callback) {

	// put the data in the ECS bucket
	if (JSON.stringify(jsonBodyToStore).indexOf("502") != 1) {
		var params = {
			Bucket: ECSbucket,
			Key: gdun + '.json',
			Body: JSON.stringify(jsonBodyToStore)
		};

		ecs.putObject(params, function(err, data) {
			if (err) {
				// an error occurred
				console.log('Error in ECS putObject: ' + err, err.stack);
			} else {
				// successful response
				var eTag = JSON.parse(data.ETag);
				console.log('data saved to ECS object ETag: ' + JSON.parse(data.ETag) );
				jsonBodyToStore = null; // free up memory
				callback(null, eTag); // this is the  callback saying this storeIBjson function is complete
			};
		});
	}
}
// This function appends zeros to the beginning of GDUN numbers in case they are less than 9 characters and missing leading zeros
function appendZeros(gdun) {
	var gdunString = gdun.toString();
	var realGdun;

	if (gdunString.length == 9) {
		realGdun = gdunString;
	} else if (gdunString.length == 8) {
		realGdun = '0' + gdunString;
	} else if (gdunString.length == 7) {
		realGdun = '00' + gdunString;
	}

	return realGdun;
}
