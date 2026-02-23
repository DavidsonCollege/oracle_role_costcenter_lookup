#!/usr/bin/env node
/**
 * Looks up the position code for an Oracle Fusion HCM employee by person number.
 *
 * Usage:
 *   node lookup-position.js <PersonNumber>
 *
 * Required environment variables:
 *   HCM_BASE_URL  - e.g. https://your-instance.fa.oraclecloud.com
 *   HCM_USERNAME  - Oracle HCM username
 *   HCM_PASSWORD  - Oracle HCM password
 */

const personNumber = process.argv[2];

if (!personNumber) {
  console.error('Usage: node lookup-position.js <PersonNumber>');
  process.exit(1);
}

const { HCM_BASE_URL, HCM_USERNAME, HCM_PASSWORD } = process.env;

if (!HCM_BASE_URL || !HCM_USERNAME || !HCM_PASSWORD) {
  console.error(
    'Error: Missing required environment variables.\n' +
    '  HCM_BASE_URL  - e.g. https://your-instance.fa.oraclecloud.com\n' +
    '  HCM_USERNAME  - Oracle HCM username\n' +
    '  HCM_PASSWORD  - Oracle HCM password'
  );
  process.exit(1);
}

async function getPositionCode(personNumber) {
  const token = Buffer.from(`${HCM_USERNAME}:${HCM_PASSWORD}`).toString('base64');

  const params = new URLSearchParams({
    q: `PersonNumber=${personNumber}`,
    expand: 'workRelationships,workRelationships.assignments',
  });

  const url = `${HCM_BASE_URL}/hcmRestApi/resources/latest/workers?${params}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Basic ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`API error ${response.status} ${response.statusText}: ${body}`);
  }

  const data = await response.json();

  if (!data.items || data.items.length === 0) {
    throw new Error(`No worker found with PersonNumber: ${personNumber}`);
  }

  const worker = data.items[0];
  const relationships = worker.workRelationships ?? [];

  if (relationships.length === 0) {
    throw new Error(`No work relationships found for PersonNumber: ${personNumber}`);
  }

  // Prefer the active primary assignment
  for (const rel of relationships) {
    for (const assignment of rel.assignments ?? []) {
      if (
        assignment.PrimaryFlag === true &&
        assignment.AssignmentStatusType === 'ACTIVE' &&
        assignment.PositionCode
      ) {
        return assignment.PositionCode;
      }
    }
  }

  // Fall back to any assignment that has a position code
  for (const rel of relationships) {
    for (const assignment of rel.assignments ?? []) {
      if (assignment.PositionCode) {
        return assignment.PositionCode;
      }
    }
  }

  throw new Error(`No position code found for PersonNumber: ${personNumber}`);
}

getPositionCode(personNumber)
  .then((code) => {
    console.log(`Person Number : ${personNumber}`);
    console.log(`Position Code : ${code}`);
  })
  .catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
