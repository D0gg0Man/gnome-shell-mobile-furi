# GNOME Shell Mobile
GNOME Shell Mobile is a set of patches on top of GNOME Shell to allow it to run on mobile phones and small tablets.

![](https://gitlab.gnome.org/verdre/gnome-shell-mobile/uploads/24687ebbb506b48af35eee3fa98668c3/mobileshell.png)

## Running and distributing
This project consists of three parts, gnome-shell-mobile (this repo), mutter-mobile (https://gitlab.gnome.org/verdre/mutter-mobile), and gnome-settings-daemon-mobile (https://gitlab.gnome.org/verdre/gnome-settings-daemon-mobile). All three need to be built in order to run GNOME Shell Mobile.

The `mobile` branch is the main development branch. It's currently based on upstream `gnome-46` and can be used for nightly/unstable images.

For distributors, there is the `gnome-46-mobile` branch which is based on the upstream `gnome-46` branch.

## Reporting bugs
Please report any issues with GNOME Shell Mobile on [this repo's issue tracker](https://gitlab.gnome.org/verdre/gnome-shell-mobile/-/issues), do not report them in the GNOME Shell issue tracker.

## Contributing
To contribute, please consider first if it makes sense to do so [upstream](https://gitlab.gnome.org/GNOME/gnome-shell/-/merge_requests), that is the case if the change is not specific to phones and can be based just fine on the upstream `main` branch.

Otherwise create a merge request for this repo targeting the `mobile` branch.

## Upstreaming
It is the intention that all changes eventually land upstream in GNOME Shell and Mutter themselves. Due to the stability and code quality requirements that is going to take a while though, which is why this repo exists for everyone wanting to use the patches or contribute in the mean time.

## License

GNOME Shell is distributed under the terms of the GNU General Public License,
version 2 or later. See the [COPYING][license] file for details.

[license]: COPYING
