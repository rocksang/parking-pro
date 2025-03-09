const findParkingBtn = document.getElementById('findParking');
const reportParkingBtn = document.getElementById('reportParking');
const citySelect = document.getElementById('city');
const locationInput = document.getElementById('location');
const parkingLengthSelect = document.getElementById('parkingLength');
const parkingTimeInput = document.getElementById('parkingTime');
const parkingTypeSelect = document.getElementById('parkingType');
const reportLocationInput = document.getElementById('reportLocation');
const reportFreeSelect = document.getElementById('reportFree');
const reportRulesInput = document.getElementById('reportRules');
const reportMaxMinutesInput = document.getElementById('reportMaxMinutes');
const resultsDiv = document.getElementById('parkingResults');

findParkingBtn.addEventListener('click', () => {
    const city = citySelect.value;
    const location = locationInput.value;
    const parkingLength = parkingLengthSelect.value;
    const parkingTime = parkingTimeInput.value;
    const parkingType = parkingTypeSelect.value;

    if (!city || !location) {
        alert('Please enter a city and location!');
        return;
    }

    fetchParking({ city, location, parkingLength, parkingTime, parkingType });
});

reportParkingBtn.addEventListener('click', () => {
    const location = reportLocationInput.value;
    const free = reportFreeSelect.value === 'true';
    const rules = reportRulesInput.value;
    const maxMinutes = reportMaxMinutesInput.value;

    if (!location) {
        alert('Please enter a location to report!');
        return;
    }

    fetch('/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location, free, rules, maxMinutes })
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            alert('Parking spot reported successfully!');
            reportLocationInput.value = '';
            reportRulesInput.value = '';
            reportMaxMinutesInput.value = '';
        } else {
            alert('Failed to report spot.');
        }
    })
    .catch(err => {
        console.error('Report error:', err);
        alert('Error reporting spot.');
    });
});

function fetchParking({ city, location, parkingLength, parkingTime, parkingType }) {
    fetch('/parking', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ city, location, parkingLength, parkingTime, parkingType })
    })
    .then(response => response.json())
    .then(data => {
        resultsDiv.innerHTML = '';
        if (data.spots.length === 0) {
            resultsDiv.innerHTML = '<p>No parking spots found for your criteria.</p>';
            return;
        }
        data.spots.forEach(spot => {
            const spotDiv = document.createElement('div');
            spotDiv.className = 'spot';
            spotDiv.innerHTML = `
                <p><strong>Location:</strong> ${spot.address}</p>
                <p><strong>Status:</strong> ${spot.free ? 'Free' : 'Paid'}</p>
                <p><strong>Rules:</strong> ${spot.rules}</p>
                ${spot.timestamp ? `<p><strong>Reported:</strong> ${new Date(spot.timestamp).toLocaleTimeString()}</p>` : ''}
            `;
            resultsDiv.appendChild(spotDiv);
        });
    })
    .catch(err => {
        console.error('Error:', err);
        resultsDiv.innerHTML = '<p>Error fetching parking info.</p>';
    });
}