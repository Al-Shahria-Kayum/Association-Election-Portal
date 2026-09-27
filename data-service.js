/* Global Supabase adapter. The UI never writes tables directly: sensitive actions
   call database RPCs that re-check identity, role, state and integrity rules. */
window.ElectionStore = {
  client() { return window.__supabaseClient || null; },
  async load(role) {
    const client = this.client();
    if (!client) return { positions: [], applications: [], reviewQueue: [], people: [], auditLogs: [] };
    const [positionsResponse, statusResponse, applicationsResponse] = await Promise.all([
      client.from('positions').select('*').order('created_at'),
      client.rpc('my_voting_status'),
      client.from('candidate_applications').select('id, position_id, status, rejection_reason, created_at, updated_at, positions(name)').order('created_at', { ascending: false })
    ]);
    if (positionsResponse.error) throw positionsResponse.error;
    if (statusResponse.error) throw statusResponse.error;
    if (applicationsResponse.error) throw applicationsResponse.error;
    const statuses = new Map((statusResponse.data || []).map(row => [row.position_id, row.voted]));
    const positions = await Promise.all((positionsResponse.data || []).map(async row => {
      const pool = await this.candidates(row.id);
      const results = row.state === 'results_published' ? await this.results(row.id) : [];
      return { id: row.id, title: row.name, state: row.state, candidates: pool.length, voted: Boolean(statuses.get(row.id)), window: this.windowLabel(row), applicants: 0, description: row.description, allowSelf: row.allow_self_vote, applicationStart: row.application_start, applicationEnd: row.application_end, votingStart: row.voting_start, votingEnd: row.voting_end, pool, results };
    }));
    let reviewQueue = [];
    let people = [];
    let auditLogs = [];
    if (role === 'admin') {
      const [queueResponse, peopleResponse, auditResponse] = await Promise.all([
        client.from('candidate_applications').select('id, position_id, status, created_at, profiles(full_name, email, department, student_id), positions(name)').eq('status', 'pending').order('created_at'),
        client.rpc('admin_people'),
        client.from('audit_logs').select('id, action_type, target_type, metadata, created_at').order('created_at', { ascending: false }).limit(100)
      ]);
      if (!queueResponse.error) reviewQueue = queueResponse.data || [];
      if (!peopleResponse.error) people = peopleResponse.data || [];
      if (!auditResponse.error) auditLogs = auditResponse.data || [];
    }
    return { positions, applications: applicationsResponse.data || [], reviewQueue, people, auditLogs };
  },
  async candidates(positionId) {
    const { data, error } = await this.client().rpc('candidate_pool', { p_position_id: positionId });
    if (error) throw error;
    return (data || []).map(row => ({ applicationId: row.application_id, name: row.full_name || 'Candidate', initials: (row.full_name || 'Candidate').split(/\s+/).slice(0,2).map(word => word[0]).join('').toUpperCase(), dept: row.department || 'DIU Student', batch: row.batch || '—', id: row.student_id || '—' }));
  },
  async results(positionId) {
    const { data, error } = await this.client().rpc('election_results', { p_position_id: positionId });
    if (error) throw error;
    return data || [];
  },
  async createPosition(details) {
    const { data, error } = await this.client().rpc('create_position', {
      p_name: details.name,
      p_description: details.description || '',
      p_application_start: details.applicationStart || null,
      p_application_end: details.applicationEnd || null,
      p_voting_start: details.votingStart || null,
      p_voting_end: details.votingEnd || null,
      p_max_candidates: details.maxCandidates || null,
      p_allow_self_vote: Boolean(details.allowSelfVote)
    });
    if (error) throw error;
    return data;
  },
  async transition(positionId, state) {
    const { data, error } = await this.client().rpc('transition_position', { p_position_id: positionId, p_next_state: state });
    if (error) throw error;
    return data;
  },
  async apply(positionId) {
    const { data, error } = await this.client().rpc('submit_application', { p_position_id: positionId });
    if (error) throw error;
    return data;
  },
  async review(applicationId, approve) {
    const { data, error } = await this.client().rpc('review_application', { p_application_id: applicationId, p_approve: approve, p_rejection_reason: null });
    if (error) throw error;
    return data;
  },
  async setMemberStatus(memberId, status) {
    const { data, error } = await this.client().rpc('set_member_status', { p_member_id: memberId, p_status: status });
    if (error) throw error;
    return data;
  },
  async vote(positionId, applicationId) {
    const { data, error } = await this.client().rpc('cast_vote', { p_position_id: positionId, p_candidate_application_id: applicationId, p_idempotency_key: crypto.randomUUID() });
    if (error) throw error;
    return data;
  },
  windowLabel(row) {
    const end = row.state === 'application_open' ? row.application_end : row.voting_end;
    if (!end) return row.state.replace('_', ' ');
    const label = row.state === 'application_open' ? 'Applications close' : 'Voting ends';
    return `${label} ${new Intl.DateTimeFormat('en-BD', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Dhaka' }).format(new Date(end))}`;
  }
};
