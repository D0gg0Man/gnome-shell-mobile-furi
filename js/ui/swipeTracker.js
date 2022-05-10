import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Mtk from 'gi://Mtk';

import * as Main from './main.js';
import * as Params from '../misc/params.js';

// FIXME: ideally these values matches physical touchpad size. We can get the
// correct values for gnome-shell specifically, since mutter uses libinput
// directly, but GTK apps cannot get it, so use an arbitrary value so that
// it's consistent with apps.
const TOUCHPAD_BASE_HEIGHT = 300;
const TOUCHPAD_BASE_WIDTH = 400;

const MIN_ANIMATION_DURATION = 100;
const MAX_ANIMATION_DURATION = 400;
const VELOCITY_THRESHOLD_TOUCH = 0.3;
const VELOCITY_THRESHOLD_TOUCHPAD = 0.6;
const DECELERATION_TOUCH = 0.998;
const DECELERATION_TOUCHPAD = 0.997;
const VELOCITY_CURVE_THRESHOLD = 2;
const DECELERATION_PARABOLA_MULTIPLIER = 0.35;

// Derivative of easeOutCubic at t=0
const DURATION_MULTIPLIER = 3;
const ANIMATION_BASE_VELOCITY = 0.002;
const EPSILON = 0.005;

const GESTURE_FINGER_COUNT = 3;

// USAGE:
//
// To correctly implement the gesture, there must be handlers for the following
// signals:
//
// begin(tracker, monitor)
//   The handler should check whether a deceleration animation is currently
//   running. If it is, it should stop the animation (without resetting
//   progress). Then it should call:
//   tracker.confirmSwipe(distance, snapPoints, currentProgress, cancelProgress)
//   If it's not called, the swipe would be ignored.
//   The parameters are:
//    * distance: the page size;
//    * snapPoints: an (sorted with ascending order) array of snap points;
//    * currentProgress: the current progress;
//    * cancelprogress: a non-transient value that would be used if the gesture
//      is cancelled.
//   If no animation was running, currentProgress and cancelProgress should be
//   same. The handler may set 'orientation' property here.
//
// update(tracker, progress)
//   The handler should set the progress to the given value.
//
// end(tracker, duration, endProgress)
//   The handler should animate the progress to endProgress. If endProgress is
//   0, it should do nothing after the animation, otherwise it should change the
//   state, e.g. change the current page or switch workspace.
//   NOTE: duration can be 0 in some cases, in this case it should finish
//   instantly.

/** A class for handling swipe gestures */
export const SwipeTracker = GObject.registerClass({
    Properties: {
        'enabled': GObject.ParamSpec.boolean(
            'enabled', null, null,
            GObject.ParamFlags.READWRITE,
            true),
        'orientation': GObject.ParamSpec.enum(
            'orientation', null, null,
            GObject.ParamFlags.READWRITE,
            Clutter.Orientation, Clutter.Orientation.HORIZONTAL),
        'distance': GObject.ParamSpec.double(
            'distance', null, null,
            GObject.ParamFlags.READWRITE,
            0, Infinity, 0),
        'allow-long-swipes': GObject.ParamSpec.boolean(
            'allow-long-swipes', null, null,
            GObject.ParamFlags.READWRITE,
            false),
        'scroll-modifiers': GObject.ParamSpec.flags(
            'scroll-modifiers', null, null,
            GObject.ParamFlags.READWRITE,
            Clutter.ModifierType, 0),
    },
    Signals: {
        'begin':  {param_types: [GObject.TYPE_UINT]},
        'update': {param_types: [GObject.TYPE_DOUBLE]},
        'end':    {param_types: [GObject.TYPE_UINT64, GObject.TYPE_DOUBLE]},
    },
}, class SwipeTracker extends GObject.Object {
    _init(actor, orientation, allowedModes, params) {
        params = Params.parse(params, {
            allowDrag: true,
            allowScroll: true,
            phase: Clutter.EventPhase.BUBBLE,
            name: 'SwipeTracker',
        });

        super._init();

        this.orientation = orientation;
        this._allowedModes = allowedModes;
        this._enabled = true;
        this._distance = -1;

        this._snapPoints = [];
        this._initialProgress = 0;
        this._cancelProgress = 0;
        this._progress = 0;

        this._panGesture = new Clutter.PanGesture({
            min_n_points: params.allowDrag ? 1 : GESTURE_FINGER_COUNT,
            max_n_points: params.allowDrag ? 0 : GESTURE_FINGER_COUNT,
        });
        this._panGesture.connect('may-recognize', () => {
            return (this._allowedModes & Main.actionMode) !== 0;
        });
        this._panGesture.connect('recognize', this._beginPanGesture.bind(this));
        this._panGesture.connect('pan-update', this._updatePanGesture.bind(this));
        this._panGesture.connect('end', this._endPanGesture.bind(this));
        this._panGesture.connect('cancel', this._cancelPanGesture.bind(this));
        this.bind_property('enabled', this._panGesture, 'enabled', 0);
        this.bind_property_full('orientation',
            this._panGesture, 'pan-axis',
            GObject.BindingFlags.SYNC_CREATE,
            (bind, source) => [
                true,
                source === Clutter.Orientation.HORIZONTAL
                    ? Clutter.PanAxis.X : Clutter.PanAxis.Y,
            ],
            null);
        actor.add_action_full(params.name, params.phase, this._panGesture);

        this._scrollEnabled = params.allowScroll;
    }

    /**
     * canHandleScrollEvent:
     * This function can be used to combine swipe gesture and mouse
     * scrolling.
     *
     * @param {Clutter.Event} scrollEvent an event to check
     * @returns {boolean} whether the event can be handled by the tracker
     */
    canHandleScrollEvent(event) {
        // FIXME: we assume ClutterPanGesture can handle touchpad scroll and discrete scroll
        // everywhere here, but there's no scroll event handling in ClutterPanGesture yet
        return false;
    }

    get enabled() {
        return this._enabled;
    }

    set enabled(enabled) {
        if (this._enabled === enabled)
            return;

        this._enabled = enabled;
        this.notify('enabled');
    }

    get distance() {
        return this._distance;
    }

    set distance(distance) {
        if (this._distance === distance)
            return;

        this._distance = distance;
        this.notify('distance');
    }

    _beginGesture(x, y) {
        const rect = new Mtk.Rectangle({x, y, width: 1, height: 1});
        let monitor = global.display.get_monitor_index_for_rect(rect);

        this.emit('begin', monitor);
    }

    _beginPanGesture(panGesture) {
        const coords = panGesture.get_begin_centroid();

        this._beginGesture(coords.x, coords.y);
    }

    _findClosestPoint(pos) {
        const distances = this._snapPoints.map(x => Math.abs(x - pos));
        const min = Math.min(...distances);
        return distances.indexOf(min);
    }

    _findNextPoint(pos) {
        return this._snapPoints.findIndex(p => p >= pos);
    }

    _findPreviousPoint(pos) {
        return this._snapPoints.findLastIndex(p => p <= pos);
    }

    _findPointForProjection(pos, velocity) {
        const initial = this._findClosestPoint(this._initialProgress);
        const prev = this._findPreviousPoint(pos);
        const next = this._findNextPoint(pos);

        // If the swipe was so small that the projection landed on the current
        // page, we still choose the next page (feels better in real use).
        if ((velocity > 0 ? prev : next) === initial)
            return velocity > 0 ? next : prev;

        return this._findClosestPoint(pos);
    }

    _getBounds(pos) {
        if (this.allowLongSwipes)
            return [this._snapPoints[0], this._snapPoints[this._snapPoints.length - 1]];

        const closest = this._findClosestPoint(pos);

        let prev, next;
        if (Math.abs(this._snapPoints[closest] - pos) < EPSILON) {
            prev = next = closest;
        } else {
            prev = this._findPreviousPoint(pos);
            next = this._findNextPoint(pos);
        }

        const lowerIndex = Math.max(prev - 1, 0);
        const upperIndex = Math.min(next + 1, this._snapPoints.length - 1);

        return [this._snapPoints[lowerIndex], this._snapPoints[upperIndex]];
    }

    _updatePanGesture(panGesture) {
        const deltaVec = panGesture.get_delta_abs();
        const delta = this.orientation === Clutter.Orientation.HORIZONTAL
            ? this._getGestureDirFactor() * deltaVec.get_x()
            : this._getGestureDirFactor() * deltaVec.get_y();

        const lastEventType = this._panGesture.get_point_event(-1).type();
        const isTouchpad = lastEventType === Clutter.EventType.TOUCHPAD_SWIPE ||
            lastEventType === Clutter.EventType.SCROLL;

        const vertical = this.orientation === Clutter.Orientation.VERTICAL;
        const distance = isTouchpad
            ? vertical ? TOUCHPAD_BASE_HEIGHT : TOUCHPAD_BASE_WIDTH
            : this._distance/* > 0 ? this._distance : global.screen_height*/; // FIXME: this shouldn't be necesssary...

        this._progress += delta / distance;

        this._progress = Math.clamp(this._progress, ...this._getBounds(this._initialProgress));

        this.emit('update', this._progress);
    }

    _getEndProgress(velocity, distance, isTouchpad) {
        const threshold = isTouchpad ? VELOCITY_THRESHOLD_TOUCHPAD : VELOCITY_THRESHOLD_TOUCH;

        if (Math.abs(velocity) < threshold)
            return this._snapPoints[this._findClosestPoint(this._progress)];

        const decel = isTouchpad ? DECELERATION_TOUCHPAD : DECELERATION_TOUCH;
        const slope = decel / (1.0 - decel) / 1000.0;

        let pos;
        if (Math.abs(velocity) > VELOCITY_CURVE_THRESHOLD) {
            const c = slope / 2 / DECELERATION_PARABOLA_MULTIPLIER;
            const x = Math.abs(velocity) - VELOCITY_CURVE_THRESHOLD + c;

            pos = slope * VELOCITY_CURVE_THRESHOLD +
                DECELERATION_PARABOLA_MULTIPLIER * x * x -
                DECELERATION_PARABOLA_MULTIPLIER * c * c;
        } else {
            pos = Math.abs(velocity) * slope;
        }

        pos = pos * Math.sign(velocity) + this._progress;
        pos = Math.clamp(pos, ...this._getBounds(this._initialProgress));

        const index = this._findPointForProjection(pos, velocity);

        return this._snapPoints[index];
    }

    _endGesture(velocity) {
        const lastEventType = this._panGesture.get_point_event(-1).type();
        const isTouchpad = lastEventType === Clutter.EventType.TOUCHPAD_SWIPE ||
            lastEventType === Clutter.EventType.SCROLL;

        const vertical = this.orientation === Clutter.Orientation.VERTICAL;
        const distance = isTouchpad
            ? vertical ? TOUCHPAD_BASE_HEIGHT : TOUCHPAD_BASE_WIDTH
            : this._distance/* > 0 ? this._distance : global.screen_height*/; // FIXME: this shouldn't be necesssary...

        const endProgress = this._getEndProgress(velocity, distance, isTouchpad);

        velocity /= distance;

        if ((endProgress - this._progress) * velocity <= 0)
            velocity = ANIMATION_BASE_VELOCITY;

        const nPoints = Math.max(1, Math.ceil(Math.abs(this._progress - endProgress)));
        const maxDuration = MAX_ANIMATION_DURATION * Math.log2(1 + nPoints);

        let duration = Math.abs((this._progress - endProgress) / velocity * DURATION_MULTIPLIER);
        if (duration > 0)
            duration = Math.clamp(duration, MIN_ANIMATION_DURATION, maxDuration);

        this.emit('end', duration, endProgress);
    }

    _endPanGesture(panGesture) {
        const velocity = panGesture.get_velocity();
        const v = this.orientation === Clutter.Orientation.HORIZONTAL
            ? this._getGestureDirFactor() * velocity.get_x()
            : this._getGestureDirFactor() * velocity.get_y();

        this._endGesture(v);
    }

    _cancelPanGesture() {
        this._endGesture(0);
    }

    _getGestureDirFactor() {
        if (this.orientation === Clutter.Orientation.HORIZONTAL &&
            Clutter.get_default_text_direction() === Clutter.TextDirection.RTL)
            return 1;

        return -1;
    }

    /**
     * Confirms a swipe. User has to call this in 'begin' signal handler,
     * otherwise the swipe wouldn't start. If there's an animation running,
     * it should be stopped first.
     *
     * `cancelProgress` must always be a snap point, or a value matching
     * some other non-transient state.
     *
     * @param {number} distance - swipe distance in pixels
     * @param {number[]} snapPoints - An array of snap points, sorted in ascending order
     * @param {number} currentProgress - initial progress value
     * @param {number} cancelProgress - the value to be used on cancelling
     */
    confirmSwipe(distance, snapPoints, currentProgress, cancelProgress) {
        this.distance = distance;
        this._snapPoints = snapPoints;
        this._initialProgress = currentProgress;
        this._progress = currentProgress;
        this._cancelProgress = cancelProgress;
    }

    destroy() {
        if (this._panGesture) {
            this._panGesture.actor?.remove_action(this._panGesture);
            delete this._panGesture;
        }
    }
});
