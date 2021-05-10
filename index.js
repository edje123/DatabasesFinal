const app = require('express')();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const sqlite3 = require("sqlite3");

let db = new sqlite3.Database('checkin.db');

function errorHandler(error, msg) {
  console.log(error);
  io.emit("error", msg);
}

function getOverlap(dateStart, dateEnd, place, person) {

  var sql = `
  SELECT DISTINCT person AS id, Person.name AS name, 
  Place.name AS place, Building.name AS building,
  Event.dateIn AS date
  FROM Event
  INNER JOIN Person ON Person.id = Event.person 
  INNER JOIN Building ON Building.id = Event.building
  INNER JOIN Place ON Place.id = Event.place
  WHERE place = ?
  AND ((dateOut BETWEEN ? AND ?)
  OR (dateIn BETWEEN ? AND ?) 
  OR ((dateIn <= ?) AND (dateOut >= ?)))`;


  var returned = [];


  db.all(sql, [place, dateStart, dateEnd, dateStart, dateEnd, dateStart, dateEnd], (err, rows) => {
    if (err) {
      console.log(err)

      if (err.errno == 0) {
        return errorHandler(err, "You must provide information to search for.");
      } else {
        return errorHandler(err, "Something went wrong while searching for date range overlaps.");
      }

    }
    if (rows) {

      rows.forEach((row) => {
        if (row.id != person) {
          io.emit("returnInfected", row);
        }

      });

    } else {
      errorHandler("No information provided.", "You must provide information to search for.")
    }
  });
}

var exclusiveList = [];

function getWithin(dateStart, dateEnd, person) {
  exclusiveList = [];

  var sql = `SELECT * FROM Event WHERE person = ? AND (dateIn >= ? OR dateOut >= ?)`;

  db.all(sql, [person, dateEnd, dateStart], (err, rows) => {
    if (err) {
      console.log(err)

      if (err.errno == 0) {
        return errorHandler(err, "You must provide information to search for.");
      } else {
        return errorHandler(err, "Something went wrong while finding recent events including this person.");
      }

    }
    if (rows) {
      rows.forEach((row) => {
        exclusiveList.push(row)
      });

    } else {
      errorHandler("No information provided.", "You must provide information to search for.")
    }

    exclusiveList.forEach((item) => {
      getOverlap(item.dateIn, item.dateOut, item.place, item.person)
    });

    if (exclusiveList.length = 0) {
      console.log("No infections")
    }
  });

}

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/views/index.html');
});

app.get('/metrics', (req, res) => {
  res.sendFile(__dirname + '/views/metrics.html');
});

app.get('/logo.png', (req, res) => {
  res.sendFile(__dirname + '/views/logo.png');
});

http.listen(3000, () => {
  console.log('listening on *:3000');
});

io.on('connection', async (socket) => {

  socket.on('getRange', (msg) => {
    var sql = `SELECT * FROM Event WHERE (dateIn BETWEEN ? AND ?) OR (dateOut BETWEEN ? AND ?)`
    db.all(sql, [msg.dateStart, msg.dateEnd, msg.dateStart, msg.dateEnd], (err, rows) => {
      if (err) {
        return errorHandler("Error getting date range.", "Something went wrong while searching for events in that time range.")
      }
      rows.forEach((row) => {
        io.emit("returnRange", row)
      })
    })
  });

  socket.on('addUser', (msg) => {
    db.run(`INSERT INTO Person(name, infectionStatus) VALUES(?, ?)`, [msg.name, "Not Infected"], function(error) {
      if (error) {
        return errorHandler(error, "Something went wrong while adding that user to the system.");
      }

      io.emit("notification", "User added successfully!")
    });
  });

  socket.on('removeUser', (msg) => {
    db.run(`DELETE FROM Event WHERE person = ?`, [msg], function(error) {
      if (error) {
        return errorHandler(error, "Something went wrong while removing that user from the system.");
      }
    });

    db.run(`DELETE FROM Infection WHERE person = ?`, [msg], function(error) {
      if (error) {
        return errorHandler(error, "Something went wrong while removing that user from the system.");
      }
    });

    db.run(`DELETE FROM Person WHERE id = ?`, [msg], function(error) {
      if (error) {
        return errorHandler(error, "Something went wrong while removing that user from the system.");
      }

      io.emit("notification", "User removed successfully!")
    });
  });

  socket.on('event', (msg) => {
    var buildingId, placeId;

    var sql = `SELECT Building.id AS bid, Place.id as pid FROM Building INNER JOIN Place ON Place.isInside = Building.id WHERE Building.name = ? AND Place.name = ?`;

    db.all(sql, [msg.building, msg.place], (err, rows) => {
      if (err) {
        return errorHandler("Error occurred searching for building/place", "Something went wrong while searching for that building/place.")
      }
      rows.forEach((row) => {
        buildingId = row.bid;
        placeId = row.pid;
      });

      if (placeId == undefined || buildingId == undefined) {
        return errorHandler("placeId = undefined", "That place or building doesn't exist!")
      }

      if (msg.type == "check_in") {
        var latestTime;
        var eventId;

        sql = `SELECT MAX(id) AS id, place, building, dateOut FROM Event WHERE Person = ?`

        db.all(sql, [msg.id], (err, rows) => {
          if (err) {
            return errorHandler("Error occurred searching for the person's last event", "Something went wrong while registering an event for that person.")
          }

          rows.forEach((row) => {
            latestTime = row.dateOut;
            eventId = row.id;

            if (row.dateOut == null && row.id != null) {
              return errorHandler("Person not checked out of previous location.", `This user has not been checked out of their previous location yet.`)
            }
            else {
              db.run(`INSERT INTO Event(dateIn, person, place, building) VALUES(?, ?, ?, ?)`, [Date.now(), msg.id, placeId, buildingId], function(error) {
                if (error) {
                  return errorHandler(error, "Data failed to insert.");
                }
                io.emit("notification", "Check in succeeded!")
              });
            }
          });


        });
      }

      var lastEventId;

      if (msg.type == "check_out") {

        var latestId;

        sql = `SELECT MAX(id) AS id, place, building, dateOut FROM Event WHERE Person = ?`

        db.all(sql, [msg.id], (err, rows) => {
          if (err) {
            return errorHandler("Error occurred searching for the person's last event", "Something went wrong while registering an event for that person.")
          }
          rows.forEach((row) => {
            latestId = row.id;

            if (row.place != placeId) {
              return errorHandler("Received place did not match place found in lastEvent row", `This user has not been checked out of their previous location yet.`)
            }

            if (row.building != buildingId) {
              return errorHandler("Received building did not match building found in lastEvent row", `This user has not been checked out of their previous location yet.`)
            }

            if (row.dateOut) {
              return errorHandler("User's last event already has a check out", `This user has already been checked out of their previous location.`)
            }
          });

          if (placeId == undefined || buildingId == undefined) {
            return errorHandler("placeId = undefined", "That place or building doesn't exist!")
          }

          db.run(`UPDATE Event SET dateOut = ? WHERE id = ?`, [Date.now(), latestId], function(error) {
            if (error) {
              return errorHandler(error, "Data failed to insert.");
            }
            io.emit("notification", "Check out succeeded!")
          });

        });
      }


    });
  });

  socket.on('userUpdate', (msg) => {

    var sql = `SELECT * FROM Person WHERE id = ?`
    var found;

    db.all(sql, [msg.id], (err, rows) => {
      if (err) {
        errorHandler("Error occurred finding person during userUpdate", "Something went wrong while searching for that person to update their info.")
      }
      rows.forEach((row) => {
        found = row;
      });

      if (found == undefined) {
        errorHandler("Person not found", "There is no person with that ID number.")
      }
    });


    if (!msg.infectionStatus == "Infected" || !msg.infectionStatus == "Not Infected") {
      return errorHandler("infectionStatus formatted incorrectly", "The user data could not be updated because the data you provided became corrupted.");
    }

    var first = 0;

    var segment = "";

    var params = [];

    if (msg.name != "" && first == 0) {
      segment = segment + `name = ?`
      first++;
      params.push(msg.name)
    }
    else if (msg.name != "" && first == 1) {
      segment = segment + `, name = ?`
      params.push(msg.name)
    }

    if (msg.infectionStatus != "-1" && first == 0) {
      segment = segment + `infectionStatus = ?`
      first++;
      params.push(msg.infectionStatus)
    }
    else if (msg.infectionStatus != "-1" && first == 1) {
      segment = segment + `, infectionStatus = ?`
      params.push(msg.infectionStatus)
    }

    if (msg.name = "" && msg.infectionStatus == "-1") {
      return errorHandler("All values in update request were blank", "You did not change any information.")
    }

    var sql = `UPDATE Person SET ${segment} WHERE id = ?`;

    params.push(msg.id)

    db.run(sql, params, function(error) {
      if (error) {
        return errorHandler(error, "Could not update user data.");
      }

      io.emit("notification", "Update succeeded!")

      if (msg.infectionStatus == "Infected") {
        var date = new Date(Date.now())
        var dateMinus = new Date(Date.now());
        dateMinus.setDate(date.getDate() - 2)

        getWithin(date.getTime(), dateMinus.getTime(), msg.id)

        db.run(`INSERT INTO Infection(date, person) VALUES(?, ?)`, [date.getTime(), msg.id], function(error) {
          if (error) {
            return errorHandler(error, "Failed to insert infection data into database.");
          }
        });
      }

      if (msg.infectionStatus == "Not Infected") {
        db.run(`DELETE FROM Infection WHERE person = ?`, [msg.id], function(error) {
          if (error) {
            return errorHandler(error, "Failed to remove infection data from database.");
          }
        });
      }
    });
  });

  socket.on('userSearch', (msg) => {
    var sql = `SELECT * FROM Person WHERE `
    var found;
    var first = 0;

    var params = []

    if (msg.name && first == 1) {
      sql = sql + `AND name = ?`
      params.push(msg.name)
    } else if (msg.name) {
      first++
      sql = sql + `name = ?`
      params.push(msg.name)
    }

    if (msg.id && first == 1) {
      sql = sql + `AND id = ?`
      params.push(msg.id)
    } else if (msg.id) {
      first++
      sql = sql + `id = ?`
      params.push(msg.id)
    }

    if (msg.infectionStatus && first == 1) {
      sql = sql + `AND infectionStatus = ?`
      params.push(msg.infectionStatus)
    } else if (msg.infectionStatus) {
      first++
      sql = sql + `infectionStatus = ?`
      params.push(msg.infectionStatus)
    }


    db.all(sql, params, (err, rows) => {
      if (err) {
        console.log(err)

        if (err.errno == 0) {
          return errorHandler(err, "You must provide information to search for.");
        } else {
          return errorHandler(err, "Something went wrong while searching for that person.");
        }

      }
      if (rows) {
        rows.forEach((row) => {
          found = row;
          socket.emit("returnSearch", row)
        });

        if (found == undefined) {
          errorHandler("Nothing found", "There is no person with that information.")
        }
      } else {
        errorHandler("No information provided.", "You must provide information to search for.")
      }
    });

  });

  socket.on('getInfections', (msg) => {
    var sql = "SELECT *, (SELECT COUNT() FROM Infection WHERE date BETWEEN ? AND ?) as numInfections FROM Infection WHERE date BETWEEN ? AND ?"
    db.all(sql, [msg.dateStart, msg.dateEnd, msg.dateStart, msg.dateEnd], (err, rows) => {
      if (err) {
        if (err) {
          return errorHandler(err, "An error occurred while trying to find infections inside that time range.");
        }
      }
      rows.forEach((row) => {
        socket.emit("returnInfections", row)
      });
    });
  });
});