#include <linux/sched.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>
#include "shell-sched.h"

/**
 * sched_attr
 *
 * The linux/sched/types.h header file conflicts with glib.h so I'm copying
 * things directly
 *
 */
struct sched_attr
{
    __u32 size;

    __u32 sched_policy;
    __u64 sched_flags;

    /* SCHED_NORMAL, SCHED_BATCH */
    __s32 sched_nice;

    /* SCHED_FIFO, SCHED_RR */
    __u32 sched_priority;

    /* SCHED_DEADLINE */
    __u64 sched_runtime;
    __u64 sched_deadline;
    __u64 sched_period;

    /* Utilization hints */
    __u32 sched_util_min;
    __u32 sched_util_max;
};

#if defined(__linux__) && !defined(HAVE_SCHED_SETATTR) && defined(SYS_sched_setattr)
#define HAVE_SCHED_SETATTR

static int sched_setattr(pid_t pid,
                         const struct sched_attr *attr,
                         unsigned int flags)
{
    return syscall(SYS_sched_setattr, pid, attr, flags);
}

static int sched_getattr(pid_t pid,
                         struct sched_attr *attr,
                         unsigned int size,
                         unsigned int flags)
{
    return syscall(SYS_sched_getattr, pid, attr, size, flags);
}
#endif

/**
 * shell_sched_set_minimal_utilization_clamping:
 * @pid: the pid for which to set clamping
 * @utilization_clamping: the value to clamp to
 * @error: the error
 *
 * Uses the sched_setattr syscall to set the minimal utilization clamping for a
 * given process.
 *
 * Returns: %TRUE if the clamp setting succeeded, %FALSE otherwise.
 */

gboolean shell_sched_set_minimal_utilization_clamping(int pid,
                                                      int utilization_clamping,
                                                      GError **error)
{
    struct sched_attr sa;

    if (sched_getattr(pid, &sa, sizeof(sa), 0) != 0)
    {
        g_set_error_literal(error, G_IO_ERROR, G_IO_ERROR_FAILED,
                            "sched_getattr failed");

        return FALSE;
    }

    sa.sched_util_min = utilization_clamping;

    sa.sched_flags = SCHED_FLAG_KEEP_POLICY |
                     SCHED_FLAG_KEEP_PARAMS |
                     SCHED_FLAG_UTIL_CLAMP_MIN;

    if (sched_setattr(pid, &sa, 0) != 0)
    {
        g_set_error_literal(error, G_IO_ERROR, G_IO_ERROR_FAILED,
                            "sched_setattr failed");

        return FALSE;
    }

    return TRUE;
}