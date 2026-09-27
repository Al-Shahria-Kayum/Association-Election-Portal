const authGate = document.getElementById('auth-gate');
const authConfig = window.SUPABASE_CONFIG || {};
const authEnabled = Boolean(authConfig.url && authConfig.publishableKey && window.supabase);
let supabaseClient = null;

function isDiuEmail(email) {
  return /^[^\s@]+@diu\.edu\.bd$/i.test(email.trim());
}
function showAuthGate(markup) {
  authGate.innerHTML = markup;
  authGate.classList.remove('hidden');
}
function verificationScreen(message = '') {
  showAuthGate(`<div class="auth-panel"><div class="auth-seal">CSA<br>DIU</div><h1>Verify your DIU email</h1><p class="lead">Use your institutional email to access the Chuadanga Student Association election portal.</p><div class="field"><label for="diu-email">DIU email address</label><input id="diu-email" type="email" autocomplete="email" placeholder="name@diu.edu.bd" /></div><button class="button button-primary" id="send-verification" onclick="sendVerification()">Send verification link</button><div class="auth-error" id="auth-error">${message}</div><div class="auth-rule"><span>✦</span><span>Only <b>@diu.edu.bd</b> addresses are eligible. We’ll send a single-use verification link to confirm that you control the inbox.</span></div><div class="auth-caption">By continuing, you agree to use one verified institutional identity for this election.</div></div>`);
}
function emailSentScreen(email) {
  showAuthGate(`<div class="auth-panel"><div class="auth-success">✓</div><h1>Check your DIU inbox</h1><p class="lead">We sent a verification link to <b>${email}</b>. Open it on this device to securely continue to the election portal.</p><div class="auth-rule"><span>◷</span><span>The link is single-use and expires according to your Supabase email-auth configuration. Check your spam folder if it doesn’t arrive shortly.</span></div><button class="auth-back" onclick="verificationScreen()">← Use a different email address</button></div>`);
}
function configurationScreen() {
  showAuthGate(`<div class="auth-panel"><div class="auth-seal">CSA<br>DIU</div><h1>Verification is not configured</h1><p class="lead">Add this portal’s Supabase URL and publishable key to enable verified DIU sign-in.</p><div class="auth-rule"><span>i</span><span>Set <b>SUPABASE_URL</b> and <b>SUPABASE_PUBLISHABLE_KEY</b>, then restart the local server. Never place a service-role key in browser configuration.</span></div></div>`);
}
async function sendVerification() {
  const input = document.getElementById('diu-email');
  const errorBox = document.getElementById('auth-error');
  const button = document.getElementById('send-verification');
  const email = input.value.trim().toLowerCase();
  if (!isDiuEmail(email)) { errorBox.textContent = 'Enter a valid @diu.edu.bd email address.'; return; }
  button.disabled = true; button.textContent = 'Sending verification link…'; errorBox.textContent = '';
  const { error } = await supabaseClient.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${window.location.origin}/` }
  });
  if (error) { button.disabled = false; button.textContent = 'Send verification link'; errorBox.textContent = 'We could not send the link. Please try again shortly.'; return; }
  emailSentScreen(email);
}
async function establishVerifiedSession() {
  const { data, error } = await supabaseClient.auth.getUser();
  const verifiedUser = data?.user;
  if (error || !verifiedUser || !isDiuEmail(verifiedUser.email || '')) { await supabaseClient.auth.signOut(); verificationScreen('Please sign in with a verified DIU address.'); return; }
  const activation = await supabaseClient.rpc('activate_verified_member');
  if (activation.error) { verificationScreen('Your verified identity could not be activated. Please contact the election committee.'); return; }
  user.name = verifiedUser.user_metadata?.full_name || verifiedUser.email.split('@')[0];
  user.email = verifiedUser.email;
  user.initials = user.name.split(/[ ._-]+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || 'DI';
  user.role = activation.data?.role === 'admin' ? 'admin' : 'student';
  document.getElementById('user-name').textContent = user.name;
  document.getElementById('user-role').textContent = user.role === 'admin' ? 'Administrator' : 'Student';
  document.querySelectorAll('.avatar-small').forEach(node => { node.textContent = user.initials; });
  document.body.classList.remove('admin', 'student');
  document.body.classList.add(user.role);
  try { await refreshRemoteData(); } catch (loadError) { verificationScreen('The election database is not ready. Run the supplied Supabase migrations, then try again.'); return; }
  restorePortalState();
  authGate.classList.add('hidden');
  render();
  const restoredContext = savedPortalState();
  if (restoredContext.activeModal === 'newPosition' && user.role === 'admin') newPosition();
  if (restoredContext.activeModal === 'apply') openApply();
}
async function bootAuth() {
  if (!authEnabled) { configurationScreen(); return; }
  supabaseClient = window.supabase.createClient(authConfig.url, authConfig.publishableKey, { auth: { persistSession: true, detectSessionInUrl: true } });
  window.__supabaseClient = supabaseClient;
  const { data } = await supabaseClient.auth.getSession();
  if (data.session) { await establishVerifiedSession(); return; }
  verificationScreen();
}

const app = document.getElementById('content');
const backdrop = document.getElementById('modal-backdrop');
const modal = document.getElementById('modal');
const user = { name: 'Verified Student', initials: 'VS', role: 'student', department: '', batch: '', id: '', email: '' };
const adminViews = new Set(['manage', 'review', 'people', 'audit']);
const positions = [];
const people = [];
let view = 'dashboard';
let selectedPosition = null;
let myApplications = [];
let reviewQueue = [];
let liveMode = false;
const portalStateKey = 'csa-diu-portal-context';

function savedPortalState() {
  try { return JSON.parse(localStorage.getItem(portalStateKey) || '{}'); } catch { return {}; }
}
function savePortalState(patch = {}) {
  const previous = savedPortalState();
  localStorage.setItem(portalStateKey, JSON.stringify({ ...previous, view, selectedPositionId: selectedPosition?.id || null, ...patch }));
}
function restorePortalState() {
  const saved = savedPortalState();
  if (saved.view && (!adminViews.has(saved.view) || user.role === 'admin')) view = saved.view;
  selectedPosition = saved.selectedPositionId ? positions.find(position => position.id === saved.selectedPositionId) || null : null;
}

async function refreshRemoteData() {
  if (!window.ElectionStore || !supabaseClient) return;
  const data = await window.ElectionStore.load(user.role);
  positions.splice(0, positions.length, ...data.positions);
  myApplications = data.applications;
  reviewQueue = data.reviewQueue;
  if (user.role === 'admin') people.splice(0, people.length, ...(data.people || []).map(row => ({ id: row.id, name: row.full_name || row.email.split('@')[0], initials: (row.full_name || row.email).split(/[ .@_-]+/).filter(Boolean).slice(0,2).map(part => part[0]).join('').toUpperCase(), dept: row.department || '—', batch: row.batch || '—', studentId: row.student_id || '—', email: row.email, status: row.account_status, role: row.role })));
  const reviewBadge = document.getElementById('review-count');
  if (reviewBadge) reviewBadge.textContent = user.role === 'admin' && reviewQueue.length ? String(reviewQueue.length) : '';
  liveMode = true;
}

const stateLabel = { voting_open: 'Voting open', application_open: 'Applications open', application_closed: 'Reviewing', results_published: 'Results published', voting_closed: 'Voting closed', draft: 'Draft' };
const stateClass = { voting_open: 'open', application_open: 'open', application_closed: 'pending', results_published: 'results', voting_closed: 'closed', draft: 'closed' };
const avatar = (initials, cls='') => `<span class="avatar ${cls}">${initials}</span>`;
const state = s => `<span class="state state-${stateClass[s]}">${stateLabel[s]}</span>`;
const positionCard = p => `<article class="election-card">
  <div class="election-top"><div><div class="position-label">Executive committee</div><div class="position-title">${p.title}</div></div>${state(p.state)}</div>
  <div class="election-meta"><span>◷ ${p.window}</span><span>◉ ${p.candidates} approved candidates</span></div>
  <div class="election-foot"><div class="candidate-count" style="margin-left:0">${p.candidates} approved candidate${p.candidates === 1 ? '' : 's'}</div>
  <button class="mini-link" onclick='openPosition(${JSON.stringify(p.id)})'>${p.state === 'voting_open' ? (p.voted ? 'View vote status →' : 'View candidates →') : 'View position →'}</button></div></article>`;

function dashboard() {
  const open = positions.filter(p => p.state === 'voting_open').length;
  const voted = positions.filter(p => p.voted).length;
  const published = positions.filter(p => p.state === 'results_published').length;
  return `<div class="page-heading"><div><h1>Welcome, ${user.name}.</h1><p class="lead">Here’s what’s happening in the CSA DIU election.</p></div><button class="button button-outline" onclick="showProfile()">View my profile</button></div>
  <div class="notice"><div class="notice-icon">✦</div><div><b>Your DIU identity is verified</b><span>You can participate in all positions that are currently open for voting.</span></div></div>
  <div class="stat-grid">
    <div class="stat-card"><div class="stat-label">Open for voting <span class="stat-icon">▣</span></div><div class="stat-number">${open}</div><div class="stat-detail">Cast your vote before closing</div></div>
    <div class="stat-card"><div class="stat-label">Votes submitted <span class="stat-icon">✓</span></div><div class="stat-number">${voted}</div><div class="stat-detail">Your voting activity is private</div></div>
    <div class="stat-card"><div class="stat-label">My applications <span class="stat-icon">◫</span></div><div class="stat-number">${myApplications.length}</div><div class="stat-detail">Tracked from your election profile</div></div>
    <div class="stat-card"><div class="stat-label">Published results <span class="stat-icon">◉</span></div><div class="stat-number">${published}</div><div class="stat-detail">Officially released positions</div></div>
  </div>
  <div class="grid-two"><div><div class="section-head"><h2>Positions requiring your attention</h2><a href="#" onclick="go('elections');return false">See all positions →</a></div>${positions.filter(p => p.state === 'voting_open').map(positionCard).join('') || '<div class="empty">No positions are currently open for voting.</div>'}</div>
  <div><div class="side-card"><div class="side-card-title">Recent activity</div><div class="empty" style="border:0;border-radius:0;padding:30px">Your verified election activity will appear here.</div></div></div></div>`;
}

function elections() {
  return `<div class="page-heading"><div><h1>Election positions</h1><p class="lead">Read candidate profiles and take part in positions open to you.</p></div></div>
  <div class="filter-row"><input class="search" id="position-search" oninput="filterPositions()" placeholder="Search positions" /><button class="filter-btn">All states ▾</button><button class="filter-btn">2026–27 ▾</button></div>
  <div id="position-list">${positions.map(positionCard).join('') || '<div class="empty">No election positions are available yet.</div>'}</div>`;
}

function candidateCard(person, position) {
  const safeName = person.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const applicationId = person.applicationId || '';
  return `<article class="candidate-card"><div class="candidate-photo"><span>${person.initials}</span></div><div class="candidate-body"><h3>${person.name}</h3><p>${person.dept} · Batch ${person.batch}</p><div class="card-footer"><span>${person.id}</span><span>Approved candidate</span></div><button class="button ${position.voted ? 'button-outline' : 'button-primary'}" ${position.voted ? 'disabled' : ''} onclick="confirmVote('${position.id}', '${safeName}', '${applicationId}')">${position.voted ? 'Vote already submitted' : 'Vote for ' + person.name.split(' ')[0]}</button></div></article>`;
}
function positionDetail(p) {
  const display = p.pool || [];
  return `<div class="page-heading"><div><button class="mini-link" onclick="go('elections')">← All positions</button><h1>${p.title}</h1><p class="lead">Executive committee · Election cycle 2026–27</p></div>${state(p.state)}</div>
  <div class="grid-two"><div><div class="notice"><div class="notice-icon">◷</div><div><b>${p.window}</b><span>Once submitted, a vote is final and cannot be changed.</span></div></div><h2 style="font-size:17px;margin:0 0 14px">Approved candidates</h2><div class="candidate-grid">${display.map(x => candidateCard(x,p)).join('') || '<div class="empty">No candidates have been approved for this position yet.</div>'}</div></div>
  <aside><div class="side-card"><div class="side-card-title">About this position</div><div style="padding:0 18px 19px;color:var(--muted);font-size:12px;line-height:1.6">${p.description}<div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--line)"><b style="color:var(--ink);font-size:11px">VOTING RULES</b><p style="margin:6px 0 0">One verified student may vote once. ${p.allowSelf ? 'Approved candidates may vote for this position.' : 'Candidates may not vote for themselves.'}</p></div></div></div></aside></div>`;
}

function applications() {
  const rows = myApplications.map(application => `<tr><td><b>${application.positions?.name || 'Position'}</b><br><span style="color:var(--muted);font-size:11px">Executive committee</span></td><td>${new Date(application.created_at).toLocaleDateString()}</td><td>${state(application.status === 'pending' ? 'application_closed' : application.status === 'approved' ? 'voting_open' : 'voting_closed')}</td><td>${new Date(application.updated_at).toLocaleDateString()}</td><td><button class="small-button" onclick="toast('Application status is recorded in the election database.')">View details</button></td></tr>`).join('');
  return `<div class="page-heading"><div><h1>My applications</h1><p class="lead">Track your candidacy applications across the election cycle.</p></div><button class="button button-primary" onclick="openApply()">+ Apply for a position</button></div>
  <div class="table-wrap"><table><thead><tr><th>Position</th><th>Submitted</th><th>Status</th><th>Last updated</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="5" style="text-align:center;color:var(--muted)">You have not applied for a position yet.</td></tr>'}</tbody></table></div>
  <div class="notice" style="margin-top:22px"><div class="notice-icon">i</div><div><b>Need to update your profile?</b><span>Changes to your personal information will be reflected in future applications.</span></div></div>`;
}

function results() { const published = liveMode ? positions.filter(position => position.state === 'results_published') : []; return `<div class="page-heading"><div><h1>Election results</h1><p class="lead">Official results published by the election committee.</p></div></div><div class="notice"><div class="notice-icon">✓</div><div><b>Results are verified and final</b><span>Results are calculated from valid ballots. Individual voting choices are never disclosed.</span></div></div>${published.length ? published.map(position => resultCard(position.title, position.results || [])).join('') : '<div class="empty">No election results have been published yet.</div>'}`; }
function resultCard(title, rows) { const total = Number(rows[0]?.total_votes || 0); return `<article class="result-card"><div class="result-header"><div><h3>${title}</h3><p>${total} valid vote${total === 1 ? '' : 's'}</p></div>${state('results_published')}</div>${rows.length ? rows.map((row,index)=>`<div class="result-row ${index===0?'winner':''}"><span class="rank">${index===0?'★':index+1}</span><b>${row.full_name}${index===0?' · Elected':''}</b><div class="progress"><i style="width:${total ? Math.round(Number(row.vote_count)/total*100) : 0}%"></i></div><span class="vote-number">${row.vote_count}</span></div>`).join('') : '<div class="empty" style="padding:27px">No valid votes were recorded for this position.</div>'}<div class="result-note">Published by the election committee from secure election records.</div></article>`; }

function dateWindow(start, end) { if (!start && !end) return 'Not scheduled'; const formatter = new Intl.DateTimeFormat('en-BD', { dateStyle:'medium', timeZone:'Asia/Dhaka' }); return `${start ? formatter.format(new Date(start)) : '—'} – ${end ? formatter.format(new Date(end)) : '—'}`; }
function manage() { return `<div class="page-heading"><div><h1>Manage elections</h1><p class="lead">Create positions, manage timelines and control election state.</p></div><button class="button button-primary" onclick="newPosition()">+ Create position</button></div><div class="table-wrap"><table><thead><tr><th>Position</th><th>Application window</th><th>Voting window</th><th>State</th><th></th></tr></thead><tbody>${positions.map(p=>`<tr><td><b>${p.title}</b><br><span style="color:var(--muted);font-size:10px">${p.candidates} approved candidates</span></td><td>${dateWindow(p.applicationStart,p.applicationEnd)}</td><td>${dateWindow(p.votingStart,p.votingEnd)}</td><td>${state(p.state)}</td><td><button class="small-button" onclick='editPosition(${JSON.stringify(p.id)})'>Manage</button></td></tr>`).join('') || '<tr><td colspan="5" style="text-align:center;color:var(--muted)">No election positions have been created.</td></tr>'}</tbody></table></div>`; }

function review() { const queue = liveMode ? reviewQueue.map(row => ({ id: row.id, name: row.profiles?.full_name || row.profiles?.email?.split('@')[0] || 'Student', initials: (row.profiles?.full_name || row.profiles?.email || 'S').split(/[ .@_-]+/).filter(Boolean).slice(0,2).map(part=>part[0]).join('').toUpperCase(), dept: row.profiles?.department || 'DIU Student', studentId: row.profiles?.student_id || '—', position: row.positions?.name || 'Position', createdAt: row.created_at })) : people.filter(x=>x.status==='pending'); return `<div class="page-heading"><div><h1>Review applications</h1><p class="lead">Review candidates and record a clear decision for every application.</p></div></div><div class="filter-row"><input class="search" placeholder="Search applicants" /><button class="filter-btn">All positions ▾</button><button class="filter-btn">Pending ▾</button></div><div class="table-wrap"><table><thead><tr><th>Applicant</th><th>Position</th><th>Submitted</th><th>Status</th><th></th></tr></thead><tbody>${queue.length ? queue.map((p,i)=>{ const safeName=p.name.replace(/\\/g,'\\\\').replace(/'/g,"\\'"); return `<tr><td><div class="person">${avatar(p.initials)}<div><b>${p.name}</b><span>${p.dept} · ${p.studentId || p.id}</span></div></div></td><td>${p.position}</td><td>${p.createdAt ? new Date(p.createdAt).toLocaleDateString() : `${23+i} Sep 2026`}</td><td>${state('application_closed')}</td><td class="table-actions"><button class="small-button" onclick="reviewApplication('${p.id}','${safeName}','approve',this)">Approve</button><button class="small-button" style="color:var(--red)" onclick="reviewApplication('${p.id}','${safeName}','reject',this)">Reject</button></td></tr>`; }).join('') : '<tr><td colspan="5" style="text-align:center;color:var(--muted)">No pending applications.</td></tr>'}</tbody></table></div>`; }

function peopleView() { const active = people.filter(person => person.status !== 'suspended').length; const suspended = people.length - active; return `<div class="page-heading"><div><h1>People</h1><p class="lead">Verified election accounts. Removing access preserves ballots and the audit trail.</p></div></div><div class="stat-grid"><div class="stat-card"><div class="stat-label">Active members <span class="stat-icon">◉</span></div><div class="stat-number">${active}</div><div class="stat-detail">Verified accounts with portal access</div></div><div class="stat-card"><div class="stat-label">Removed access <span class="stat-icon">⊘</span></div><div class="stat-number">${suspended}</div><div class="stat-detail">Preserved for election integrity</div></div></div><div class="table-wrap"><table><thead><tr><th>Student</th><th>Department</th><th>Batch</th><th>Role</th><th>Account</th></tr></thead><tbody>${people.map(p=>{ const safeName=p.name.replace(/\\/g,'\\\\').replace(/'/g,"\\'"); const nextStatus=p.status==='suspended'?'active':'suspended'; return `<tr><td><div class="person">${avatar(p.initials)}<div><b>${p.name}</b><span>${p.studentId || p.id || p.email}</span></div></div></td><td>${p.dept}</td><td>${p.batch}</td><td><span class="state ${p.role==='admin'?'state-results':'state-open'}">${p.role || 'student'}</span></td><td class="table-actions"><span class="state ${p.status==='suspended'?'state-closed':'state-open'}">${p.status==='suspended'?'Removed':'Active'}</span><button class="small-button" style="color:${p.status==='suspended'?'var(--green-dark)':'var(--red)'}" onclick="confirmMemberStatus('${p.id}','${nextStatus}','${safeName}')">${p.status==='suspended'?'Restore':'Remove access'}</button></td></tr>`; }).join('')}</tbody></table></div>`; }

function audit() { return `<div class="page-heading"><div><h1>Audit log</h1><p class="lead">Sensitive system activity, recorded with actor and timestamp.</p></div></div><div class="side-card"><div class="empty" style="border:0;border-radius:0">Audit entries will appear here as administrators manage the election.</div></div>`; }

function render() { if (adminViews.has(view) && user.role !== 'admin') view = 'dashboard'; document.querySelectorAll('.nav-link').forEach(n=>n.classList.toggle('active', n.dataset.view === view)); const renderers = {dashboard,elections,applications,results,manage,review,people:peopleView,audit}; app.innerHTML = selectedPosition ? positionDetail(selectedPosition) : renderers[view](); }
function go(v) { if (adminViews.has(v) && user.role !== 'admin') { toast('Administrator access is required.', 'error'); return; } selectedPosition = null; view = v; savePortalState(); render(); window.scrollTo({top:0,behavior:'smooth'}); document.getElementById('sidebar').classList.remove('show'); }
async function openPosition(id) { selectedPosition = positions.find(p=>p.id===id); if (liveMode && selectedPosition) { try { selectedPosition.pool = await window.ElectionStore.candidates(id); selectedPosition.candidates = selectedPosition.pool.length; } catch { toast('Could not load candidate profiles.', 'error'); } } savePortalState(); render(); window.scrollTo({top:0,behavior:'smooth'}); }
function filterPositions(){ const q=document.getElementById('position-search').value.toLowerCase();document.getElementById('position-list').innerHTML=positions.filter(p=>p.title.toLowerCase().includes(q)).map(positionCard).join('')||'<div class="empty">No positions match your search.</div>'; }
function confirmVote(id, candidate, applicationId = null) { const p=positions.find(x=>x.id===id); const safeCandidate=candidate.replace(/\\/g,'\\\\').replace(/'/g,"\\'"); modal.innerHTML=`<h2>Confirm your vote</h2><p>Please review your selection carefully. Votes are final once confirmed and cannot be changed.</p><div class="chosen"><b>${candidate}</b><span>${p.title} · Executive committee election</span></div><p style="font-size:11px">Your ballot is private. This action will be securely recorded against your verified account to prevent duplicate voting.</p><div class="modal-actions"><button class="button button-outline" onclick="closeModal()">Cancel</button><button class="button button-primary" onclick="submitVote('${id}','${safeCandidate}','${applicationId || ''}')">Confirm vote</button></div>`;backdrop.classList.remove('hidden'); }
async function submitVote(id,candidate,applicationId) { const p=positions.find(x=>x.id===id); try { if (liveMode) await window.ElectionStore.vote(id, applicationId); p.voted=true;p.choice=candidate;closeModal();toast(`Your vote for ${candidate} has been recorded.`, 'success');selectedPosition=p;render(); } catch { toast('Vote was not confirmed. Please retry.', 'error'); } }
function closeModal(){backdrop.classList.add('hidden');savePortalState({ activeModal:null });}
function openApply(){ const saved = savedPortalState(); savePortalState({ activeModal:'apply' }); modal.innerHTML=`<h2>Apply for candidacy</h2><p>Choose a position that is accepting applications. Your verified profile will be used for review.</p><div class="field" style="margin-top:18px"><label>Open position</label><select id="apply-position" onchange="savePortalState({ applicationPositionId: this.value })">${positions.filter(x=>x.state==='application_open').map(x=>`<option value="${x.id}" ${x.id===saved.applicationPositionId?'selected':''}>${x.title}</option>`).join('')}</select></div><div class="modal-actions"><button class="button button-outline" onclick="closeModal()">Cancel</button><button class="button button-primary" onclick="submitApplication()">Continue application</button></div>`;backdrop.classList.remove('hidden'); }
async function submitApplication(){try{if(liveMode)await window.ElectionStore.apply(document.getElementById('apply-position').value);closeModal();savePortalState({ applicationPositionId: null });await refreshRemoteData();toast('Your application has been saved for review.','success');go('applications');}catch{toast('Your application could not be submitted.','error');}}
function savePositionDraft(){savePortalState({ positionDraft:{ title:document.getElementById('new-title')?.value || '', applicationStart:document.getElementById('application-start')?.value || '', applicationEnd:document.getElementById('application-end')?.value || '' } });}
function newPosition(){ const draft = savedPortalState().positionDraft || {}; savePortalState({ activeModal:'newPosition' }); modal.innerHTML=`<h2>Create election position</h2><p>Positions start as drafts. Structural details lock when applications are opened.</p><div class="form-grid" style="margin-top:18px"><div class="field full"><label>Position title</label><input id="new-title" oninput="savePositionDraft()" value="${draft.title || ''}" placeholder="Position title"></div><div class="field"><label>Application start</label><input id="application-start" oninput="savePositionDraft()" type="date" value="${draft.applicationStart || ''}"></div><div class="field"><label>Application end</label><input id="application-end" oninput="savePositionDraft()" type="date" value="${draft.applicationEnd || ''}"></div></div><div class="modal-actions"><button class="button button-outline" onclick="closeModal()">Cancel</button><button class="button button-primary" onclick="savePosition()">Create draft</button></div>`;backdrop.classList.remove('hidden'); }
async function savePosition(){let title=document.getElementById('new-title').value.trim()||'Sports Secretary';try{if(liveMode)await window.ElectionStore.createPosition(title,document.getElementById('application-start').value||null,document.getElementById('application-end').value||null);else positions.push({id:Date.now(),title,state:'draft',candidates:0,voted:false,window:'Set the election schedule',applicants:0,description:'A new executive committee position.'});closeModal();savePortalState({ positionDraft:null });if(liveMode)await refreshRemoteData();toast(`${title} was created as a draft.`,'success');render();}catch{toast('Position could not be created.','error');}}
function editPosition(id){const p=positions.find(x=>x.id===id);modal.innerHTML=`<h2>Manage ${p.title}</h2><p>Election state transitions are audit logged and enforced for all participants.</p><div class="field" style="margin-top:18px"><label>Current state</label><select id="state-select">${['draft','application_open','application_closed','voting_open','voting_closed','results_published'].map(x=>`<option value="${x}" ${x===p.state?'selected':''}>${stateLabel[x]}</option>`).join('')}</select></div><div class="modal-actions"><button class="button button-outline" onclick="closeModal()">Cancel</button><button class="button button-primary" onclick='transitionPosition(${JSON.stringify(id)})'>Save transition</button></div>`;backdrop.classList.remove('hidden');}
async function transitionPosition(id){const p=positions.find(x=>x.id===id);const nextState=document.getElementById('state-select').value;try{if(liveMode)await window.ElectionStore.transition(id,nextState);p.state=nextState;closeModal();toast(`${p.title} is now ${stateLabel[p.state].toLowerCase()}.`,'success');render();}catch{toast('This state transition was rejected.','error');}}
async function reviewApplication(id,name,action,el){try{if(liveMode)await window.ElectionStore.review(id,action==='approve');el.closest('tr').querySelector('.table-actions').innerHTML=`<span class="state state-${action==='approve'?'open':'closed'}">${action==='approve'?'Approved':'Rejected'}</span>`;if(liveMode)await refreshRemoteData();toast(`${name}'s application was ${action==='approve'?'approved':'rejected'} and logged.`, 'success');}catch{toast('The review decision could not be saved.','error');}}
function confirmMemberStatus(id, status, name) { const safeName=name.replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'&quot;'); modal.innerHTML=`<h2>${status === 'suspended' ? 'Remove member access?' : 'Restore member access?'}</h2><p>${status === 'suspended' ? 'This person will no longer be able to use the portal. Their existing votes, applications, and audit history remain protected.' : 'This person will be able to verify and sign in again.'}</p><div class="chosen"><b>${name}</b><span>${status === 'suspended' ? 'Access will be removed and logged.' : 'Access will be restored and logged.'}</span></div><div class="modal-actions"><button class="button button-outline" onclick="closeModal()">Cancel</button><button class="button ${status === 'suspended' ? 'button-danger' : 'button-primary'}" onclick="setMemberStatus('${id}','${status}','${safeName}')">${status === 'suspended' ? 'Remove access' : 'Restore access'}</button></div>`;backdrop.classList.remove('hidden');}
async function setMemberStatus(id,status,name){try{await window.ElectionStore.setMemberStatus(id,status);closeModal();await refreshRemoteData();render();toast(`${name}'s access was ${status==='suspended'?'removed':'restored'}.`,'success');}catch{toast('The account status could not be changed.','error');}}
function showProfile(){modal.innerHTML=`<h2>My profile</h2><p>Your personal information is visible only to election administrators unless a field is explicitly included in a candidate profile.</p><div class="chosen"><b>${user.name}</b><span>${user.email} · Verified</span></div><div class="modal-actions"><button class="button button-primary" onclick="closeModal()">Done</button></div>`;backdrop.classList.remove('hidden');}
function toast(message, type='success'){const t=document.createElement('div');t.className=`toast ${type}`;t.textContent=message;document.getElementById('toast-stack').append(t);setTimeout(()=>t.remove(),4000);}
document.querySelectorAll('.nav-link').forEach(n=>n.addEventListener('click',()=>go(n.dataset.view))); document.getElementById('menu-toggle').addEventListener('click',()=>document.getElementById('sidebar').classList.toggle('show')); backdrop.addEventListener('click',e=>{if(e.target===backdrop)closeModal()});document.getElementById('profile-menu').addEventListener('click',showProfile);
bootAuth();
