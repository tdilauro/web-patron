# circulation-patron-web
A Circulation Manager web interface for library patrons.

## Running the application
There are three ways to run this application:
* with a [library registry](https://github.com/NYPL-Simplified/library_registry)
* with a single library on a [circulation manager](https://github.com/NYPL-Simplified/circulation)
* with a configuration file for multiple circulation manager URLs

By default, it expects a library registry to be running at http://localhost:7000.

Any circulation manager you'll be using with the app also needs a configuration setting to turn on CORS headers. In the admin interface, go to the Sitewide Settings section under System Configuration and add a setting for "URL of the web catalog for patrons". For development, you can set this to "*", but for production it should be the real URL where you will run the catalog. If you are using a library registry, this configuration will automatically be created when you registry libraries with the registry, but you need to configure the URL in the registry by running `bin/configuration/configure_site_setting --setting="web_client_url=http://library.org/{uuid}"` (replace the URL with your web client URL). Otherwise, you'll need to create a sitewide setting for it in the circulation manager.

Once you have a library registry or circulation manager, run `npm install` in this repository to set up dependencies.

Then you can run either `npm run dev` or `npm run prod` to start the application. `npm run dev` will watch the code for changes and rebuild the front-end code, but won't reload the server code.

Set one of the following environment variables:
* To configure a library registry url, set the environment variable `REGISTRY_BASE`.
* To use a circulation manager, set `SIMPLIFIED_CATALOG_BASE`.
* To use a configuration file, set `CONFIG_FILE` to point to a local file or a remote URL. Each line in the file should be a library's desired URL path in the web catalog and the library's circ manager URL, separated by a pipe character. For example:
```
library1|http://circulationmanager.org/L1
library2|http://circulationmanager.org/L2
```

Set `SHORTEN_URLS=false` to stop the app from removing common parts of the circulation manager URLs from the web app's URLs.

Set `CACHE_EXPIRATION_SECONDS` to control how often the app will check for changes to registry entries and circ manager authentication documents.



## License

```
Copyright © 2015 The New York Public Library, Astor, Lenox, and Tilden Foundations

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

   http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```
