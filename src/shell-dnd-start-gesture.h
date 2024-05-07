#ifndef __SHELL_DND_START_GESTURE_H__
#define __SHELL_DND_START_GESTURE_H__

G_BEGIN_DECLS

#include <clutter/clutter.h>
#include <st/st.h>

#define SHELL_TYPE_DND_START_GESTURE (shell_dnd_start_gesture_get_type ())
G_DECLARE_FINAL_TYPE (ShellDndStartGesture, shell_dnd_start_gesture,
                      SHELL, DND_START_GESTURE, ClutterGesture)

void shell_dnd_start_gesture_start_drag (ShellDndStartGesture *self,
                                         const ClutterEvent   *start_event);

void shell_dnd_start_gesture_get_drag_coords (ShellDndStartGesture *self,
                                              graphene_point_t     *coords_out);

const ClutterEvent * shell_dnd_start_gesture_get_point_begin_event (ShellDndStartGesture *self);

const ClutterEvent * shell_dnd_start_gesture_get_drag_triggering_event (ShellDndStartGesture *self);

gboolean shell_dnd_start_gesture_get_manual_mode (ShellDndStartGesture *self);

void shell_dnd_start_gesture_set_manual_mode (ShellDndStartGesture *self,
                                              gboolean              manual_mode);

guint32 shell_dnd_start_gesture_get_timeout_threshold (ShellDndStartGesture *self);

void shell_dnd_start_gesture_set_timeout_threshold (ShellDndStartGesture *self,
                                                    guint32               timeout_threshold_ms);

G_END_DECLS

#endif /* __SHELL_DND_START_GESTURE_H__ */
