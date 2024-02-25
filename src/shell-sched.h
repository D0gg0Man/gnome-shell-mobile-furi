#include <glib.h>
#include <gio/gio.h>

gboolean shell_sched_set_minimal_utilization_clamping(int pid,
                                                      int utilization_clamping,
                                                      GError **error);