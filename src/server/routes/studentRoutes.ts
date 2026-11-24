import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/index.ts';
import {
  academicYears,
  attendanceCorrectionRequests,
  attendanceRecords,
  attendanceSessions,
  biometricTemplates,
  classes,
  collegeSettings,
  departments,
  semesters,
  studentEnrollments,
  subjects,
} from '../../db/schema.ts';
import { type AuthRequest, requireAuth, requireRole } from '../../middleware/auth.ts';
import {
  averageAndNormalizeDescriptors,
  computeFaceDistance,
  computeGeofenceDistanceMeters,
  decryptBiometricDescriptor,
  encryptBiometricDescriptor,
  formatISTTimestamp,
  getISTDateString,
} from '../crypto.ts';
import { writeAuditLog } from '../audit.ts';

export const studentRouter = Router();

studentRouter.use(requireAuth, requireRole('student'));

const attendanceMarkLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attendance verification attempts. Please wait a moment.' },
});

studentRouter.get('/dashboard', async (req: AuthRequest, res) => {
  try {
    const student = req.authProfile!;

    const [enrollment] = await db
      .select({
        id: studentEnrollments.id,
        rollNumber: studentEnrollments.rollNumber,
        departmentId: studentEnrollments.departmentId,
        departmentCode: departments.code,
        departmentName: departments.name,
        academicYearId: studentEnrollments.academicYearId,
        yearLabel: academicYears.label,
        semesterId: studentEnrollments.semesterId,
        semesterLabel: semesters.label,
        classId: studentEnrollments.classId,
        className: classes.displayName,
        isActive: studentEnrollments.isActive,
      })
      .from(studentEnrollments)
      .innerJoin(departments, eq(studentEnrollments.departmentId, departments.id))
      .innerJoin(academicYears, eq(studentEnrollments.academicYearId, academicYears.id))
      .innerJoin(semesters, eq(studentEnrollments.semesterId, semesters.id))
      .innerJoin(classes, eq(studentEnrollments.classId, classes.id))
      .where(eq(studentEnrollments.studentId, student.id))
      .limit(1);

    if (!enrollment) {
      return res.status(404).json({ error: 'Student enrollment record not found.' });
    }

    const [bio] = await db
      .select({
        sampleCount: biometricTemplates.sampleCount,
        consentTimestamp: biometricTemplates.consentTimestamp,
        retentionPolicyVersion: biometricTemplates.retentionPolicyVersion,
        isActive: biometricTemplates.isActive,
      })
      .from(biometricTemplates)
      .where(and(eq(biometricTemplates.studentId, student.id), eq(biometricTemplates.isActive, true)))
      .limit(1);

    const [settings] = await db.select().from(collegeSettings).limit(1);

    // Active eligible sessions for this student's department & class
    const activeSessions = await db
      .select({
        id: attendanceSessions.id,
        sessionCode: attendanceSessions.sessionCode,
        subjectId: attendanceSessions.subjectId,
        subjectCode: subjects.code,
        subjectName: subjects.name,
        sessionDate: attendanceSessions.sessionDate,
        startTime: attendanceSessions.startTime,
        endTime: attendanceSessions.endTime,
        periodSlot: attendanceSessions.periodSlot,
        status: attendanceSessions.status,
      })
      .from(attendanceSessions)
      .innerJoin(subjects, eq(attendanceSessions.subjectId, subjects.id))
      .where(
        and(
          eq(attendanceSessions.departmentId, enrollment.departmentId),
          eq(attendanceSessions.classId, enrollment.classId),
          eq(attendanceSessions.status, 'active')
        )
      )
      .orderBy(desc(attendanceSessions.createdAt));

    // Student's marked records across closed/active sessions
    const records = await db
      .select({
        id: attendanceRecords.id,
        sessionId: attendanceRecords.sessionId,
        attendanceDate: attendanceRecords.attendanceDate,
        markedAt: attendanceRecords.markedAt,
        status: attendanceRecords.status,
        verificationMethod: attendanceRecords.verificationMethod,
        verificationResult: attendanceRecords.verificationResult,
        faceConfidence: attendanceRecords.faceConfidence,
        livenessPassed: attendanceRecords.livenessPassed,
        subjectId: attendanceRecords.subjectId,
        subjectCode: subjects.code,
        subjectName: subjects.name,
        sessionCode: attendanceSessions.sessionCode,
        startTime: attendanceSessions.startTime,
        endTime: attendanceSessions.endTime,
      })
      .from(attendanceRecords)
      .innerJoin(subjects, eq(attendanceRecords.subjectId, subjects.id))
      .innerJoin(attendanceSessions, eq(attendanceRecords.sessionId, attendanceSessions.id))
      .where(eq(attendanceRecords.studentId, student.id))
      .orderBy(desc(attendanceRecords.markedAt))
      .limit(200);

    // All conducted sessions for student's class (to calculate working days & absent days accurately)
    const conductedSessions = await db
      .select({
        id: attendanceSessions.id,
        sessionDate: attendanceSessions.sessionDate,
        subjectId: attendanceSessions.subjectId,
        subjectCode: subjects.code,
        subjectName: subjects.name,
        status: attendanceSessions.status,
      })
      .from(attendanceSessions)
      .innerJoin(subjects, eq(attendanceSessions.subjectId, subjects.id))
      .where(
        and(
          eq(attendanceSessions.classId, enrollment.classId),
          inArray(attendanceSessions.status, ['active', 'closed'])
        )
      );

    const recordBySessionId = new Map(records.map((r) => [r.sessionId, r]));
    const workingDaysSet = new Set<string>();
    const presentDaysSet = new Set<string>();
    const subjectStatsMap = new Map<
      string,
      { subjectId: string; subjectCode: string; subjectName: string; present: number; total: number }
    >();

    for (const s of conductedSessions) {
      workingDaysSet.add(s.sessionDate);
      const rec = recordBySessionId.get(s.id);
      const isPresent = rec?.status === 'present' || rec?.status === 'excused';
      if (isPresent) {
        presentDaysSet.add(s.sessionDate);
      }

      const existingSub = subjectStatsMap.get(s.subjectId) ?? {
        subjectId: s.subjectId,
        subjectCode: s.subjectCode,
        subjectName: s.subjectName,
        present: 0,
        total: 0,
      };
      // Only count closed sessions or sessions where student already marked attendance as total conducted
      if (s.status === 'closed' || rec) {
        existingSub.total += 1;
        if (isPresent) existingSub.present += 1;
      }
      subjectStatsMap.set(s.subjectId, existingSub);
    }

    const totalConducted = Array.from(subjectStatsMap.values()).reduce((sum, x) => sum + x.total, 0);
    const totalPresentSessions = Array.from(subjectStatsMap.values()).reduce(
      (sum, x) => sum + x.present,
      0
    );
    const workingDays = workingDaysSet.size;
    const presentDays = presentDaysSet.size;
    const absentDays = Math.max(0, workingDays - presentDays);
    const attendancePercentage =
      totalConducted > 0 ? Math.round((totalPresentSessions / totalConducted) * 1000) / 10 : 100;

    // Calendar summary by date (YYYY-MM-DD)
    const calendarMap = new Map<string, { date: string; status: 'present' | 'absent' | 'partial'; sessions: number; present: number }>();
    for (const s of conductedSessions) {
      const rec = recordBySessionId.get(s.id);
      if (s.status !== 'closed' && !rec) continue;
      const cur = calendarMap.get(s.sessionDate) ?? {
        date: s.sessionDate,
        status: 'absent',
        sessions: 0,
        present: 0,
      };
      cur.sessions += 1;
      if (rec?.status === 'present' || rec?.status === 'excused') {
        cur.present += 1;
      }
      cur.status = cur.present === cur.sessions ? 'present' : cur.present > 0 ? 'partial' : 'absent';
      calendarMap.set(s.sessionDate, cur);
    }

    const markedSessionIds = new Set(records.map((r) => r.sessionId));
    const activeSessionsAnnotated = activeSessions.map((s) => ({
      ...s,
      alreadyMarked: markedSessionIds.has(s.id),
    }));

    const overrideRequests = await db
      .select()
      .from(attendanceCorrectionRequests)
      .where(eq(attendanceCorrectionRequests.studentId, student.id))
      .orderBy(desc(attendanceCorrectionRequests.createdAt))
      .limit(20);

    res.json({
      student,
      enrollment,
      biometricStatus: bio
        ? {
            enrolled: true,
            sampleCount: bio.sampleCount,
            consentTimestamp: bio.consentTimestamp,
            retentionPolicyVersion: bio.retentionPolicyVersion,
          }
        : { enrolled: false, sampleCount: 0, consentTimestamp: null, retentionPolicyVersion: null },
      summary: {
        attendancePercentage,
        workingDays,
        presentDays,
        absentDays,
        totalSessions: totalConducted,
        presentSessions: totalPresentSessions,
      },
      subjectWise: Array.from(subjectStatsMap.values()).map((s) => ({
        ...s,
        percentage: s.total > 0 ? Math.round((s.present / s.total) * 1000) / 10 : 100,
      })),
      calendar: Array.from(calendarMap.values()),
      activeSessions: activeSessionsAnnotated,
      recentRecords: records.map((r) => ({
        ...r,
        markedAtIST: formatISTTimestamp(new Date(r.markedAt)),
      })),
      overrideRequests,
      collegeSettings: settings ?? null,
    });
  } catch (err) {
    console.error('Student dashboard error:', err);
    res.status(500).json({ error: 'Failed to load student dashboard.' });
  }
});

const enrollBiometricSchema = z.object({
  consentGiven: z.literal(true, { message: 'Informed biometric consent is mandatory.' }),
  descriptors: z
    .array(z.array(z.number().finite()).length(128))
    .min(3, 'At least 3 live face samples are required for enrollment.')
    .max(5),
});

studentRouter.post('/biometrics/enroll', async (req: AuthRequest, res) => {
  try {
    const student = req.authProfile!;
    if (student.status !== 'approved') {
      return res.status(403).json({ error: 'Only approved students can enroll facial biometrics.' });
    }

    const parsed = enrollBiometricSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid biometric samples.' });
    }

    const normalizedTemplate = averageAndNormalizeDescriptors(parsed.data.descriptors);
    const encrypted = encryptBiometricDescriptor(normalizedTemplate);

    await db
      .insert(biometricTemplates)
      .values({
        studentId: student.id,
        encryptedDescriptor: encrypted.encryptedDescriptor,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        algorithm: 'face-api-128d-aes256gcm',
        sampleCount: parsed.data.descriptors.length,
        consentGiven: true,
        consentTimestamp: new Date(),
        retentionPolicyVersion: 'SBIST-BIO-2026-v1',
        isActive: true,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: biometricTemplates.studentId,
        set: {
          encryptedDescriptor: encrypted.encryptedDescriptor,
          iv: encrypted.iv,
          authTag: encrypted.authTag,
          sampleCount: parsed.data.descriptors.length,
          consentGiven: true,
          consentTimestamp: new Date(),
          isActive: true,
          updatedAt: new Date(),
        },
      });

    await writeAuditLog({
      actorId: student.id,
      actorEmail: student.email,
      actorRole: 'student',
      action: 'BIOMETRIC_TEMPLATE_ENROLLED',
      entityType: 'biometric_template',
      entityId: student.id,
      details: { sampleCount: parsed.data.descriptors.length, policy: 'SBIST-BIO-2026-v1' },
      ipAddress: req.clientIp,
    });

    res.json({
      message: 'Face template encrypted and enrolled successfully.',
      sampleCount: parsed.data.descriptors.length,
      retentionPolicyVersion: 'SBIST-BIO-2026-v1',
    });
  } catch (err) {
    console.error('Biometric enrollment error:', err);
    res.status(500).json({ error: 'Failed to enroll biometric template.' });
  }
});

studentRouter.delete('/biometrics', async (req: AuthRequest, res) => {
  try {
    const student = req.authProfile!;
    await db.delete(biometricTemplates).where(eq(biometricTemplates.studentId, student.id));

    await writeAuditLog({
      actorId: student.id,
      actorEmail: student.email,
      actorRole: 'student',
      action: 'BIOMETRIC_TEMPLATE_DELETED',
      entityType: 'biometric_template',
      entityId: student.id,
      ipAddress: req.clientIp,
    });

    res.json({ message: 'Biometric template permanently deleted. You may re-enroll at any time.' });
  } catch (err) {
    console.error('Biometric deletion error:', err);
    res.status(500).json({ error: 'Failed to delete biometric template.' });
  }
});

const markAttendanceSchema = z.object({
  sessionId: z.string().uuid('Please select an active attendance session.'),
  descriptor: z.array(z.number().finite()).length(128),
  livenessPassed: z.boolean(),
  livenessSignals: z
    .object({
      blinkDetected: z.boolean(),
      headTurnDetected: z.boolean(),
      frameVariance: z.number().nonnegative(),
    })
    .optional(),
  latitude: z.number().finite().nullable().optional(),
  longitude: z.number().finite().nullable().optional(),
});

studentRouter.post('/attendance/mark', attendanceMarkLimiter, async (req: AuthRequest, res) => {
  try {
    const student = req.authProfile!;
    const parsed = markAttendanceSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid verification payload.' });
    }
    const payload = parsed.data;

    // Step 3: Backend checks approved and active account
    if (student.status !== 'approved') {
      return res.status(403).json({ error: 'Account is not approved or active.' });
    }

    const [enrollment] = await db
      .select()
      .from(studentEnrollments)
      .where(and(eq(studentEnrollments.studentId, student.id), eq(studentEnrollments.isActive, true)))
      .limit(1);

    if (!enrollment) {
      return res.status(403).json({ error: 'Active class enrollment not found for your account.' });
    }

    // Step 4 & 5: Check active session & department/class eligibility
    const [session] = await db
      .select()
      .from(attendanceSessions)
      .where(eq(attendanceSessions.id, payload.sessionId))
      .limit(1);

    if (!session || session.status !== 'active') {
      return res.status(404).json({ error: 'No active attendance session is available for your class.' });
    }

    if (
      session.departmentId !== enrollment.departmentId ||
      session.classId !== enrollment.classId
    ) {
      return res.status(403).json({
        error: 'No active attendance session is available for your class.',
      });
    }

    const [settings] = await db.select().from(collegeSettings).limit(1);
    const locationEnabled = settings?.locationVerificationEnabled ?? true;
    const geofenceRadius = settings?.geofenceRadiusMeters ?? 300;
    const faceThreshold = settings?.faceMatchThreshold ?? 0.5;
    const livenessRequired = settings?.livenessRequired ?? true;

    // Check attendance frequency constraints (once_per_day / morning_afternoon)
    const frequency = settings?.attendanceFrequency ?? 'every_class_period';
    if (frequency === 'once_per_day') {
      const existingToday = await db
        .select({ id: attendanceRecords.id })
        .from(attendanceRecords)
        .where(
          and(
            eq(attendanceRecords.studentId, student.id),
            eq(attendanceRecords.attendanceDate, session.sessionDate),
            eq(attendanceRecords.status, 'present')
          )
        )
        .limit(1);
      if (existingToday.length > 0) {
        return res.status(409).json({
          error: 'Daily attendance has already been marked today under Once-Per-Day college policy.',
        });
      }
    } else if (frequency === 'morning_afternoon') {
      const slotGroup = session.periodSlot === 'afternoon' ? 'afternoon' : 'morning';
      const existingSlot = await db
        .select({ id: attendanceRecords.id, periodSlot: attendanceSessions.periodSlot })
        .from(attendanceRecords)
        .innerJoin(attendanceSessions, eq(attendanceRecords.sessionId, attendanceSessions.id))
        .where(
          and(
            eq(attendanceRecords.studentId, student.id),
            eq(attendanceRecords.attendanceDate, session.sessionDate),
            eq(attendanceRecords.status, 'present')
          )
        );
      if (existingSlot.some((e) => (e.periodSlot === 'afternoon' ? 'afternoon' : 'morning') === slotGroup)) {
        return res.status(409).json({
          error: `Attendance has already been marked for the ${slotGroup} session today.`,
        });
      }
    }

    // Step 6 & 7: Geofence location verification (if enabled)
    let distanceMeters: number | null = null;
    if (locationEnabled) {
      if (payload.latitude == null || payload.longitude == null) {
        return res.status(400).json({
          error: 'Location permission is required by college policy to verify campus proximity.',
          code: 'LOCATION_REQUIRED',
        });
      }
      distanceMeters = computeGeofenceDistanceMeters(
        payload.latitude,
        payload.longitude,
        settings!.collegeLatitude,
        settings!.collegeLongitude
      );
      if (distanceMeters > geofenceRadius) {
        await writeAuditLog({
          actorId: student.id,
          actorEmail: student.email,
          actorRole: 'student',
          action: 'GEOFENCE_VERIFICATION_FAILED',
          entityType: 'attendance_session',
          entityId: session.id,
          details: { distanceMeters, allowedRadius: geofenceRadius },
          ipAddress: req.clientIp,
        });
        return res.status(403).json({
          error: `Outside campus geofence (${distanceMeters}m away; allowed radius is ${geofenceRadius}m). You may request a staff-assisted override.`,
          code: 'OUTSIDE_GEOFENCE',
          distanceMeters,
          allowedRadius: geofenceRadius,
        });
      }
    }

    // Step 10: Retrieve and decrypt enrolled biometric template on trusted backend
    const [template] = await db
      .select()
      .from(biometricTemplates)
      .where(and(eq(biometricTemplates.studentId, student.id), eq(biometricTemplates.isActive, true)))
      .limit(1);

    if (!template) {
      return res.status(400).json({
        error: 'Face enrollment is required before marking attendance. Please complete Face Enrollment first.',
        code: 'BIOMETRIC_NOT_ENROLLED',
      });
    }

    // Step 11: Liveness verification
    if (livenessRequired) {
      const signalsValid =
        payload.livenessPassed &&
        (!payload.livenessSignals ||
          (payload.livenessSignals.blinkDetected && payload.livenessSignals.frameVariance > 0.0001));
      if (!signalsValid) {
        await writeAuditLog({
          actorId: student.id,
          actorEmail: student.email,
          actorRole: 'student',
          action: 'LIVENESS_CHECK_FAILED',
          entityType: 'attendance_session',
          entityId: session.id,
          ipAddress: req.clientIp,
        });
        return res.status(403).json({
          error:
            'Liveness verification failed (blink/motion check incomplete). Please retry or use Staff-Assisted attendance.',
          code: 'LIVENESS_FAILED',
        });
      }
    }

    // Normalize live descriptor and compute Euclidean distance against enrolled template
    const [normalizedLive] = [averageAndNormalizeDescriptors([payload.descriptor])];
    const enrolledVector = decryptBiometricDescriptor(
      template.encryptedDescriptor,
      template.iv,
      template.authTag
    );
    const distance = computeFaceDistance(normalizedLive, enrolledVector);
    const confidence = Math.max(0, Math.min(1, Math.round((1 - distance) * 1000) / 1000));

    if (distance > faceThreshold) {
      await writeAuditLog({
        actorId: student.id,
        actorEmail: student.email,
        actorRole: 'student',
        action: 'FACE_VERIFICATION_REJECTED',
        entityType: 'attendance_session',
        entityId: session.id,
        details: { distance: Math.round(distance * 1000) / 1000, threshold: faceThreshold },
        ipAddress: req.clientIp,
      });
      return res.status(403).json({
        error: `Face verification rejected (match distance ${distance.toFixed(3)} exceeds threshold ${faceThreshold.toFixed(2)}). Ensure proper lighting and only your face is in frame, or request Staff-Assisted verification.`,
        code: 'FACE_MISMATCH',
      });
    }

    // Step 12, 13, 14: Atomic transaction re-checking session active + unique constraint insert
    const istDate = session.sessionDate || getISTDateString();

    const insertResult = await db.transaction(async (tx) => {
      const [freshSession] = await tx
        .select()
        .from(attendanceSessions)
        .where(eq(attendanceSessions.id, session.id))
        .limit(1);

      if (!freshSession || freshSession.status !== 'active') {
        return { kind: 'inactive' as const };
      }

      const inserted = await tx
        .insert(attendanceRecords)
        .values({
          studentId: student.id,
          sessionId: session.id,
          departmentId: enrollment.departmentId,
          classId: enrollment.classId,
          subjectId: session.subjectId,
          attendanceDate: istDate,
          status: 'present',
          verificationMethod: locationEnabled ? 'face_geofence' : 'face_only',
          verificationResult: 'verified',
          faceConfidence: confidence,
          livenessPassed: payload.livenessPassed,
          latitude: payload.latitude ?? null,
          longitude: payload.longitude ?? null,
          geofenceDistanceM: distanceMeters,
        })
        .onConflictDoNothing({
          target: [attendanceRecords.studentId, attendanceRecords.sessionId],
        })
        .returning();

      if (inserted.length === 0) {
        return { kind: 'duplicate' as const };
      }
      return { kind: 'created' as const, record: inserted[0] };
    });

    if (insertResult.kind === 'inactive') {
      return res.status(409).json({
        error: 'No active attendance session is available for your class.',
      });
    }
    if (insertResult.kind === 'duplicate') {
      return res.status(409).json({
        error: 'Attendance has already been marked for this session.',
      });
    }

    await writeAuditLog({
      actorId: student.id,
      actorEmail: student.email,
      actorRole: 'student',
      action: 'ATTENDANCE_MARKED',
      entityType: 'attendance_record',
      entityId: insertResult.record.id,
      details: {
        sessionId: session.id,
        sessionCode: session.sessionCode,
        confidence,
        distanceMeters,
      },
      ipAddress: req.clientIp,
    });

    res.status(201).json({
      message: 'Attendance marked successfully.',
      record: {
        ...insertResult.record,
        markedAtIST: formatISTTimestamp(new Date(insertResult.record.markedAt)),
      },
    });
  } catch (err: unknown) {
    // Handle PostgreSQL unique violation code 23505 defensively
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === '23505') {
      return res.status(409).json({
        error: 'Attendance has already been marked for this session.',
      });
    }
    console.error('Mark attendance error:', err);
    res.status(500).json({ error: 'Failed to save attendance record.' });
  }
});

const overrideRequestSchema = z.object({
  sessionId: z.string().uuid('Please select a valid attendance session.'),
  requestType: z.enum(['location_bypass', 'liveness_assisted', 'correction']),
  reason: z.string().min(10, 'Please provide a clear reason (at least 10 characters).').max(500),
});

studentRouter.post('/attendance/override-request', async (req: AuthRequest, res) => {
  try {
    const student = req.authProfile!;
    const parsed = overrideRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid request.' });
    }

    const [created] = await db
      .insert(attendanceCorrectionRequests)
      .values({
        studentId: student.id,
        sessionId: parsed.data.sessionId,
        requestedBy: student.id,
        requestedStatus: 'present',
        requestType: parsed.data.requestType,
        reason: parsed.data.reason.trim(),
        status: 'pending',
      })
      .returning();

    await writeAuditLog({
      actorId: student.id,
      actorEmail: student.email,
      actorRole: 'student',
      action: 'ATTENDANCE_OVERRIDE_REQUESTED',
      entityType: 'attendance_correction_request',
      entityId: created.id,
      details: { requestType: parsed.data.requestType, sessionId: parsed.data.sessionId },
      ipAddress: req.clientIp,
    });

    res.status(201).json({
      message: 'Verification exception request submitted to faculty/admin for review.',
      request: created,
    });
  } catch (err) {
    console.error('Override request error:', err);
    res.status(500).json({ error: 'Failed to submit request.' });
  }
});
