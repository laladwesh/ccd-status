// "Meet the Team" page (link only; the D-Day portal itself is not touched). Change it here.
export const TEAM_URL = 'https://iitg.ac.in/dday/team';

// Status palette (approved): operational #107C10, degraded #B7791F, down #D83B01,
// upstream/impacted #7C2D3E, maintenance #5F6A82.
export const STATE_META = {
  operational: { label: 'Operational', color: '#107C10' },
  degraded: { label: 'Degraded', color: '#B7791F' },
  down: { label: 'Down', color: '#D83B01' },
  nginx_issue: { label: 'Server nginx issue', short: 'Server nginx issue', color: '#7C2D3E' },
  upstream_outage: { label: 'Upstream / campus network issue', short: 'Upstream issue', color: '#7C2D3E' },
  db_impacted: { label: 'Impacted by database', short: 'Database impact', color: '#7C2D3E' },
  maintenance: { label: 'Maintenance', color: '#5F6A82' },
  unknown: { label: 'Unknown', color: '#9CA0AE' },
};
export const stateMeta = (s) => STATE_META[s] || STATE_META.unknown;

export const OVERALL_META = {
  operational: { color: '#107C10' },
  degraded: { color: '#B7791F' },
  partial: { color: '#D83B01' },
  major: { color: '#B22D00' },
  upstream: { color: '#7C2D3E', note: 'This looks like a campus network / iitg.ac.in problem, not individual portal failures. The portals may be running normally.' },
  nginx: { color: '#7C2D3E', note: 'The web server (nginx) on the status host is not serving the portal routes correctly. The applications themselves are probably still running.' },
  database: { color: '#7C2D3E', note: 'The shared database on the server is not responding. Dependent portals are marked as impacted.' },
  maintenance: { color: '#5F6A82' },
};

export const GROUPS = ['Placement', 'Internship', 'Training', 'Industry', 'PhD', 'Others'];
export const INCIDENT_STATUS = ['investigating', 'identified', 'monitoring', 'resolved'];
export const INCIDENT_COLOR = { investigating: '#D83B01', identified: '#B7791F', monitoring: '#5F6A82', resolved: '#107C10' };
