// learner.js
const { Client } = require("pg");
const getAssignedStudents = async (proctor_id, exam_id) => {
  const client = new Client({
    host: "3.108.23.145",
    port: 5432,
    user: "postgres",
    password: "Pariksha@303",
    database: "University_database_development",
  });
  try {
    await client.connect();
    const assignmentQuery = `
      SELECT student_id
      FROM "Assign_proctor_student"
      WHERE exam_id = $1
      AND proctor_id = $2
      AND active_status = 'active'
      LIMIT 1;
    `;
    const assignmentRes = await client.query(assignmentQuery, [exam_id, proctor_id]);
    if (assignmentRes.rowCount === 0) return [];
    const assignment = assignmentRes.rows[0];
    let allStudentIds = [];
    if (assignment.student_id) {
      if (Array.isArray(assignment.student_id)) {
        allStudentIds = assignment.student_id.map(id => parseInt(id, 10));
      } else if (typeof assignment.student_id === "string") {
        try {
          const parsed = JSON.parse(assignment.student_id);
          if (Array.isArray(parsed)) allStudentIds = parsed.map(id => parseInt(id, 10));
        } catch {
          allStudentIds = [parseInt(assignment.student_id, 10)];
        }
      }
    }
    if (allStudentIds.length === 0) return [];
    const userQuery = `
      SELECT id, full_name, email, phone, role
      FROM "Users"
      WHERE id = ANY($1::int[]);
    `;
    const userRes = await client.query(userQuery, [allStudentIds]);
    return userRes.rows;
  } catch (err) {
    console.error("Error fetching assigned students:", err);
    return [];
  } finally {
    await client.end();
  }
};
// Export the function
module.exports = { getAssignedStudents };